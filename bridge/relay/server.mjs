#!/usr/bin/env node
/**
 * ego-lite relay.
 *
 * Sits between the agent (HTTP, this process) and the laptop bridge
 * (WebSocket, outbound from the laptop). It never touches a browser itself.
 *
 *   agent  --HTTP /api/...-->  relay  --WebSocket-->  bridge on laptop  --> ego-browser
 *
 * Security model, deliberately small:
 * - The bridge authenticates with EGO_BRIDGE_TOKEN. The agent authenticates
 *   with EGO_AGENT_TOKEN (a different secret). If EGO_AGENT_TOKEN is unset the
 *   /api routes refuse to start, so an open relay can never be pointed at
 *   someone's browser.
 * - The agent can only name tasks from bridge/tasks/. It cannot send code.
 * - Loopback callers (the in-sandbox agent) skip the agent token only when
 *   EGO_RELAY_ALLOW_LOOPBACK is set to 1, which is the default for local dev.
 *
 * HTTP surface:
 *   GET  /api/health                 liveness, no auth
 *   GET  /api/bridge                 bridge state + advertised tasks   [auth]
 *   GET  /api/tasks                  task catalogue with descriptions   [auth]
 *   POST /api/run                    { task, params?, timeoutMs? }      [auth]
 *   GET  /api/jobs/:id               job status and output              [auth]
 *   POST /api/tasks/shots/:name      accept a PNG from the laptop       [auth via header]
 *   GET  /shots/:name                serve a captured PNG               [public]
 *   GET  /                           tiny status page                   [public]
 */

import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TASKS_DIR = join(REPO_ROOT, "bridge", "tasks");
const SHOTS_DIR = process.env.EGO_BRIDGE_SHOTS || join(REPO_ROOT, "bridge", ".state", "shots");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const BRIDGE_TOKEN = process.env.EGO_BRIDGE_TOKEN || "";
const AGENT_TOKEN = process.env.EGO_AGENT_TOKEN || "";
const ALLOW_LOOPBACK = process.env.EGO_RELAY_ALLOW_LOOPBACK !== "0";
const JOB_TTL_MS = 1000 * 60 * 30;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

if (!BRIDGE_TOKEN) {
  console.error("EGO_BRIDGE_TOKEN is required: the relay will not run unauthenticated.");
  process.exit(2);
}

/** @type {{ ws: any, info: any, since: number } | null} */
let bridge = null;
/** @type {Map<string, any>} */
const jobs = new Map();
/** @type {Map<string, { resolve: Function, reject: Function, timer: any }>} */
const pending = new Map();
/** Job-scoped tokens that may upload screenshots for that job only. */
const captureTokens = new Map();

// ---------------------------------------------------------------- HTTP helpers

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearer(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return req.headers["x-ego-agent-token"] || "";
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function authorized(req) {
  if (!AGENT_TOKEN) return false;
  const presented = bearer(req);
  if (presented && safeEqual(presented, AGENT_TOKEN)) return true;
  return ALLOW_LOOPBACK && isLoopback(req) && !presented;
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", rejectPromise);
  });
}

// ------------------------------------------------------------------ task catalogue

/** Read a task's front-matter summary so /api/tasks can explain itself. */
async function taskCatalogue() {
  const entries = await readdir(TASKS_DIR).catch(() => []);
  const tasks = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".mjs")) continue;
    const task = name.slice(0, -4);
    if (!/^[a-z0-9-]+$/.test(task)) continue;
    const source = await readFile(join(TASKS_DIR, name), "utf8").catch(() => "");
    tasks.push({
      task,
      title: matchMeta(source, "title") || task,
      params: matchMeta(source, "params") || "{}",
      checks: matchMeta(source, "checks") || "",
      writes: /shot\(/.test(source),
    });
  }
  return tasks;
}

function matchMeta(source, key) {
  const match = source.match(new RegExp(`^ *// *@${key} *:?(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

// ------------------------------------------------------------------------- bridge

/** Public job shape: never leaks the internal promise or waiter state. */
function jobView(job) {
  return {
    id: job.id,
    task: job.task,
    params: job.params,
    status: job.status,
    createdAt: job.createdAt,
    ms: job.ms,
    result: job.result,
  };
}

function bridgeSummary() {
  if (!bridge) {
    return {
      connected: false,
      hint: "Start bridge/laptop/bridge.mjs on the laptop with the same relay URL and token.",
    };
  }
  return {
    connected: true,
    connectedForMs: Date.now() - bridge.since,
    ...bridge.info,
  };
}

function dispatch({ task, params = {}, timeoutMs = 180_000 }) {
  if (!bridge) {
    const error = new Error(
      "no laptop bridge is connected; start bridge/laptop/bridge.mjs on the laptop",
    );
    error.status = 503;
    throw error;
  }
  const jobId = randomUUID();
  const job = {
    id: jobId,
    task,
    params,
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: Date.now(),
    result: null,
    log: [],
  };
  jobs.set(jobId, job);

  const promise = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(jobId);
      job.status = "timeout";
      job.result = {
        ok: false,
        stderr: `task ${task} did not finish within ${timeoutMs}ms`,
      };
      rejectPromise(Object.assign(new Error(job.result.stderr), { status: 504 }));
    }, Number(timeoutMs) + 15_000);
    pending.set(jobId, { resolve: resolvePromise, reject: rejectPromise, timer });
  });

  const captureToken = randomUUID();
  captureTokens.set(captureToken, jobId);
  setTimeout(() => captureTokens.delete(captureToken), 1000 * 60 * 30).unref?.();

  bridge.ws.send(
    JSON.stringify({
      type: "job",
      jobId,
      task,
      params,
      timeoutMs: Number(timeoutMs),
      captureToken,
    }),
  );
  job.promise = promise;
  return job;
}

function onBridgeFrame(frame, socket) {
  switch (frame.type) {
    case "hello": {
      if (!safeEqual(frame.token || "", BRIDGE_TOKEN)) {
        socket.close(4003, "bad bridge token");
        return;
      }
      bridge = {
        ws: socket,
        since: Date.now(),
        info: {
          host: String(frame.host || "unknown-laptop"),
          platform: String(frame.platform || ""),
          node: String(frame.node || ""),
          fingerprint: String(frame.fingerprint || ""),
          tasks: Array.isArray(frame.tasks) ? frame.tasks : [],
        },
      };
      console.log(`[relay] bridge connected: ${bridge.info.host} (${bridge.info.tasks.length} tasks)`);
      return;
    }
    case "ping":
      socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    case "job.result": {
      const job = jobs.get(frame.jobId);
      const waiter = pending.get(frame.jobId);
      if (!job) return;
      job.status = frame.ok ? "done" : "failed";
      job.finishedAt = Date.now();
      job.ms = frame.ms;
      job.result = {
        ok: Boolean(frame.ok),
        exitCode: frame.exitCode,
        stdout: String(frame.stdout || ""),
        stderr: String(frame.stderr || ""),
      };
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(frame.jobId);
        waiter.resolve(job);
      }
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------- shots

async function saveShot(name, body, agentTokenHeader, captureTokenHeader) {
  const isAgent =
    agentTokenHeader && AGENT_TOKEN && safeEqual(agentTokenHeader, AGENT_TOKEN);
  const jobId = captureTokenHeader && captureTokens.get(captureTokenHeader);
  if (!isAgent && !jobId) {
    const error = new Error("a valid agent token or job capture token is required");
    error.status = 401;
    throw error;
  }
  if (!/^[a-z0-9-]{1,80}\.png$/.test(name)) {
    const error = new Error("shot name must match [a-z0-9-]+.png");
    error.status = 400;
    throw error;
  }
  await mkdir(SHOTS_DIR, { recursive: true });
  const finalName = jobId ? `${name}` : name;
  const path = join(SHOTS_DIR, finalName);
  await writeFile(path, body);
  return { path, bytes: body.length, url: `/shots/${finalName}`, jobId: jobId || null };
}

// ----------------------------------------------------------------------- routes

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  try {
    if (path === "/api/health") {
      return json(res, 200, {
        ok: true,
        bridge: Boolean(bridge),
        tasks: (await taskCatalogue()).length,
        jobs: jobs.size,
      });
    }

    if (path === "/api/bridge") {
      if (!authorized(req)) return json(res, 401, { error: "agent token required" });
      return json(res, 200, { bridge: bridgeSummary(), catalogue: await taskCatalogue() });
    }

    if (path === "/api/tasks") {
      if (!authorized(req)) return json(res, 401, { error: "agent token required" });
      return json(res, 200, { tasks: await taskCatalogue() });
    }

    if (path === "/api/run" && req.method === "POST") {
      if (!authorized(req)) return json(res, 401, { error: "agent token required" });
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!body.task) return json(res, 400, { error: "task is required" });
      let job;
      try {
        job = dispatch(body);
      } catch (error) {
        return json(res, error.status || 500, { error: error.message, bridge: bridgeSummary() });
      }
      if (body.wait === false) {
        return json(res, 202, { jobId: job.id, status: job.status });
      }
      const finished = await job.promise.catch((error) => ({ error: error.message, id: job.id }));
      if (finished.error) return json(res, 504, finished);
      return json(res, 200, jobView(finished));
    }

    if (path.startsWith("/api/jobs/")) {
      if (!authorized(req)) return json(res, 401, { error: "agent token required" });
      const id = path.slice("/api/jobs/".length);
      const job = jobs.get(id);
      if (!job) return json(res, 404, { error: "unknown job" });
      return json(res, 200, jobView(job));
    }

    if (path.startsWith("/api/tasks/shots/") && req.method === "POST") {
      const name = path.slice("/api/tasks/shots/".length);
      const body = await readBody(req);
      const saved = await saveShot(name, body, bearer(req), req.headers["x-ego-shot-token"]);
      return json(res, 201, saved);
    }

    if (path.startsWith("/shots/")) {
      const name = path.slice("/shots/".length);
      if (!/^[a-z0-9-]{1,80}\.png$/.test(name)) return json(res, 400, { error: "bad shot name" });
      try {
        const bytes = await readFile(join(SHOTS_DIR, name));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(bytes);
      } catch {
        json(res, 404, { error: "no such shot" });
      }
      return;
    }

    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(statusPage(bridgeSummary()));
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, error.status || 500, { error: error.message });
  }
});

// --------------------------------------------------------------- websocket server

/**
 * A dependency-free RFC 6455 server, only as much as this bridge needs:
 * text frames, ping/pong, and close. Keeps the relay runnable from a bare
 * checkout with no npm install.
 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/bridge") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);

  const ws = makeSocket(socket);
  socket.on("data", (chunk) => ws.feed(chunk));
  socket.on("close", () => {
    if (bridge?.ws === ws) bridge = null;
  });
  socket.on("error", () => {
    if (bridge?.ws === ws) bridge = null;
  });
  ws.onmessage = (text) => {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    onBridgeFrame(frame, ws);
  };
});

function makeSocket(socket) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  const ws = {
    readyState: 1,
    onmessage: null,
    send(text) {
      const payload = Buffer.from(text, "utf8");
      socket.write(encodeFrame(payload, 0x1));
    },
    close(code = 1000, reason = "") {
      ws.readyState = 3;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      try {
        socket.write(encodeFrame(payload, 0x8));
        socket.end();
      } catch {
        socket.destroy();
      }
    },
    feed(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(64 * 1024 * 1024)) {
            ws.close(1009, "frame too large");
            return;
          }
          length = Number(big);
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4);
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        buffer = buffer.subarray(offset + length);

        if (opcode === 0x8) {
          ws.readyState = 3;
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeFrame(payload, 0xa));
          continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x0) {
          fragments.push(payload);
          if (first & 0x80) {
            const full = Buffer.concat(fragments);
            fragments = [];
            ws.onmessage?.(full.toString("utf8"));
          }
          continue;
        }
        if (first & 0x80) {
          ws.onmessage?.(payload.toString("utf8"));
        } else {
          fragments = [payload];
        }
      }
    },
  };
  return ws;
}

function encodeFrame(payload, opcode) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------- housekeeping

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}, 60_000).unref?.();

setInterval(() => {
  if (!bridge) return;
  try {
    bridge.ws.send(JSON.stringify({ type: "ping", at: Date.now() }));
  } catch {
    bridge = null;
  }
}, 25_000).unref?.();

function statusPage(summary) {
  const rows = summary.connected
    ? summary.tasks
        .map((task) => `<li><code>${task.name}</code>${task.pinned ? " <em>pinned</em>" : ""}</li>`)
        .join("")
    : "<li>no laptop connected yet</li>";
  return `<!doctype html><meta charset="utf-8"><title>ego-lite relay</title>
<style>
 body{font:15px/1.5 ui-sans-serif,system-ui;margin:40px;max-width:720px;color:#111}
 code{background:#f1f1f4;padding:.1em .35em;border-radius:4px}
 .pill{display:inline-block;padding:.15em .6em;border-radius:999px;font-size:13px}
 .on{background:#dcfce7;color:#166534}.off{background:#fee2e2;color:#991b1b}
 li{margin:.2em 0}
</style>
<h1>ego-lite relay</h1>
<p>Bridge: <span class="pill ${summary.connected ? "on" : "off"}">${summary.connected ? "connected" : "offline"}</span>
${summary.connected ? `— ${summary.host} · ${summary.platform}` : ""}</p>
<h2>Tasks advertised by the laptop</h2><ul>${rows}</ul>
<p>Agent API: <code>POST /api/run</code> with <code>{"task":"smoke-ego","params":{}}</code></p>`;
}

await mkdir(SHOTS_DIR, { recursive: true }).catch(() => {});
server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT}`);
  console.log(`[relay] bridge endpoint: ws://${HOST}:${PORT}/bridge`);
  if (!AGENT_TOKEN) {
    console.warn(
      "[relay] EGO_AGENT_TOKEN is unset: every /api route will answer 401. Set it to enable the agent.",
    );
  }
});
