#!/usr/bin/env node
/**
 * Agent-side client for the bridge: one command per task.
 *
 *   node bridge/agent/run-task.mjs --task t1-read-logged-in --params '{"url":"https://x.com"}'
 *
 * Reads EGO_RELAY_URL and EGO_AGENT_TOKEN from the environment when the flags
 * are absent, so the agent in the sandbox can keep them in one place.
 */

const args = parseArgs(process.argv.slice(2));
const relay = (args.relay || process.env.EGO_RELAY_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const token = args.token || process.env.EGO_AGENT_TOKEN || "";
const task = args.task;
const wait = args["no-wait"] ? false : true;

if (!task) {
  console.error(`usage: node bridge/agent/run-task.mjs --task <name> [--params '<json>'] [--no-wait]
       env: EGO_RELAY_URL, EGO_AGENT_TOKEN`);
  const res = await fetch(relay + "/api/tasks", { headers: token ? { authorization: `Bearer ${token}` } : {} })
    .then((r) => r.json())
    .catch(() => null);
  if (res?.tasks) {
    console.error("\navailable tasks:");
    for (const item of res.tasks) console.error(`  ${item.task.padEnd(22)} ${item.title}`);
  }
  process.exit(2);
}

let params = {};
if (args.params) {
  try {
    params = JSON.parse(args.params);
  } catch (error) {
    console.error(`--params must be JSON: ${error.message}`);
    process.exit(2);
  }
}

const response = await fetch(relay + "/api/run", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ task, params, wait, timeoutMs: Number(args.timeout || 180_000) }),
});

const body = await response.json().catch(() => ({ error: "non-JSON response" }));
if (response.status === 202) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}
if (!response.ok) {
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(`# task ${body.task} — ${body.status} in ${body.ms}ms (exit ${body.result.exitCode})`);
if (body.result.stdout) console.log(body.result.stdout.trimEnd());
if (body.result.stderr) console.error("\n# stderr\n" + body.result.stderr.trimEnd());
process.exit(body.result.ok ? 0 : 1);

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
