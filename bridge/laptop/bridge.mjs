#!/usr/bin/env node
/**
 * ego-lite laptop bridge.
 *
 * Runs on the user's laptop. It connects *outbound* to the relay, so no inbound
 * port on the laptop is opened and no router/NAT changes are needed. The relay
 * only forwards opaque frames; every browser action still runs on the laptop
 * through the ego-lite `ego-browser` CLI.
 *
 *   relay  <--WebSocket, token-->  bridge.mjs  --spawn-->  ego-browser nodejs
 *
 * Protocol (JSON text frames, both directions):
 *
 *   bridge -> relay  { type: "hello", token, host, platform, node, tasks: [...] }
 *   bridge -> relay  { type: "job.result", jobId, ok, exitCode, stdout, stderr, ms }
 *   relay  -> bridge { type: "job", jobId, task, allowedHosts }
 *   relay  -> bridge { type: "ping" }
 *   bridge -> relay  { type: "pong" }
 *
 * Frames larger than MAX_FRAME_CHARS are replaced by a truncated preview so a
 * chatty snapshot cannot burn the tunnel or the agent's context.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TASKS_DIR = join(REPO_ROOT, "bridge", "tasks");
const EGO_BROWSER_BIN = process.env.EGO_BROWSER_BIN || "ego-browser";
const KIT_PATH = join(HERE, "..", "tasks", "_kit.snippet.js");

const args = parseArgs(process.argv.slice(2));
const relayUrl = args.relay || process.env.EGO_BRIDGE_RELAY;
const token = args.token || process.env.EGO_BRIDGE_TOKEN;
const host = args.host || process.env.EGO_BRIDGE_HOST || hostname();
const verbose = args.verbose === "true" || args.verbose === true;
const allowUnpinnedTasks =
  args["allow-unpinned"] === "true" || args["allow-unpinned"] === true || true;

if (!relayUrl || !token) {
  console.error(
    "usage: node bridge/laptop/bridge.mjs --relay wss://<relay-host> --token <token> [--host <label>] [--verbose]",
  );
  console.error(
    "       (or set EGO_BRIDGE_RELAY / EGO_BRIDGE_TOKEN instead of the flags)",
  );
  process.exit(2);
}

let ws = null;
let reconnectDelay = 1000;
let heartbeat = null;
let stopping = false;

async function taskManifest() {
  const entries = await readdir(TASKS_DIR).catch(() => []);
  const names = entries
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => name.slice(0, -4))
    .sort();
  const tasks = [];
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    tasks.push({ name, pinned: name.startsWith("pinned-") });
  }
  return tasks;
}

function connect() {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";

  ws = new WebSocket(url);

  ws.addEventListener("open", async () => {
    reconnectDelay = 1000;
    const tasks = await taskManifest();
    send({
      type: "hello",
      token,
      host,
      platform: `${platform()} ${release()}`,
      node: process.version,
      fingerprint: createHash("sha256").update(host).digest("hex").slice(0, 12),
      tasks,
    });
    log(`connected to ${url.origin}, advertises ${tasks.length} tasks`);
    heartbeat = setInterval(() => send({ type: "ping", at: Date.now() }), 20_000);
  });

  ws.addEventListener("message", (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (frame.type === "job") {
      runJob(frame).catch((error) => {
        send({
          type: "job.result",
          jobId: frame.jobId,
          ok: false,
          exitCode: -1,
          stdout: "",
          stderr: String(error?.stack || error),
          ms: 0,
        });
      });
    }
  });

  ws.addEventListener("close", () => {
    clearInterval(heartbeat);
    if (stopping) return;
    log(`disconnected; retrying in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.addEventListener("error", (event) => {
    log(`socket error: ${event.message || "unknown"}`);
  });
}

function send(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

/**
 * Every task is a pinned script that lives in bridge/tasks/. The relay may only
 * name a task and pass JSON parameters; it can never deliver code. That keeps
 * the laptop's exec surface fixed and auditable.
 */
async function runJob({ jobId, task, params, timeoutMs, captureToken }) {
  const started = Date.now();
  if (!/^[a-z0-9-]+$/.test(String(task))) {
    return sendResult(jobId, started, {
      ok: false,
      exitCode: 2,
      stderr: `invalid task name: ${task}`,
    });
  }
  const scriptPath = join(TASKS_DIR, `${task}.mjs`);
  let code;
  try {
    code = await readFile(scriptPath, "utf8");
  } catch {
    return sendResult(jobId, started, {
      ok: false,
      exitCode: 2,
      stderr: `unknown task: ${task}. Available tasks live in bridge/tasks/`,
    });
  }

  log(`job ${jobId} -> task ${task}`);
  // The task helpers read these off globalThis: the relay origin for screenshot
  // uploads plus the job-scoped token that authorises only that upload.
  code = await expandIncludes(code);

  const script = [
    `const __params = ${JSON.stringify(params ?? {})};`,
    `globalThis.params = __params;`,
    `globalThis.__relay = ${JSON.stringify({
      url: String(relayUrl).replace(/^ws/, "http").replace(/\/bridge$/, ""),
      jobId,
      captureToken: captureToken ?? null,
      host,
    })};`,
    code,
  ].join("\n");

  const result = await runEgoBrowser(script, timeoutMs);
  return sendResult(jobId, started, result);
}

/**
 * Tasks are single files; the few shared helpers live in tasks/_kit.snippet.js
 * and are spliced in at read time via a `//#include task-kit` line.
 */
async function expandIncludes(source) {
  if (!source.includes("//#include task-kit")) return source;
  const kitSource = await readFile(KIT_PATH, "utf8");
  return source.replaceAll("//#include task-kit", kitSource.trim());
}

function runEgoBrowser(script, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(EGO_BROWSER_BIN, ["nodejs"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, Math.min(Number(timeoutMs) || 180_000, 600_000));

    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(payload);
    };

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      done({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr:
          error.code === "ENOENT"
            ? `ego-browser not found (${EGO_BROWSER_BIN}). Install ego lite on this laptop and finish onboarding, or set EGO_BROWSER_BIN.`
            : String(error.message || error),
      });
    });
    child.on("close", (exitCode) => {
      done({
        ok: exitCode === 0,
        exitCode: exitCode ?? -1,
        stdout: clip(Buffer.concat(out).toString("utf8")),
        stderr: clip(Buffer.concat(err).toString("utf8")),
      });
    });

    child.stdin.end(script);
  });
}

function sendResult(jobId, started, payload) {
  send({
    type: "job.result",
    jobId,
    ok: Boolean(payload.ok),
    exitCode: payload.exitCode ?? -1,
    stdout: payload.stdout || "",
    stderr: payload.stderr || "",
    ms: Date.now() - started,
  });
}

const MAX_FRAME_CHARS = 12_000;

/** Keep head and tail so a truncated snapshot still shows the page's start and end. */
function clip(text) {
  if (!text) return "";
  if (text.length <= MAX_FRAME_CHARS) return text;
  const head = text.slice(0, MAX_FRAME_CHARS - 4000);
  const tail = text.slice(-3800);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n… [bridge truncated ${omitted} chars] …\n\n${tail}`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function log(message) {
  if (!verbose && !process.env.EGO_BRIDGE_VERBOSE) return;
  console.error(`[bridge ${new Date().toISOString()}] ${message}`);
}

process.on("SIGINT", () => {
  stopping = true;
  ws?.close();
  process.exit(0);
});

connect();
