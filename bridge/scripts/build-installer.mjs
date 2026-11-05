#!/usr/bin/env node
/**
 * Build `bridge/install.mjs`: a single self-contained file the user downloads on
 * their laptop. It embeds the laptop-side files (bridge.mjs, tasks, fixture) and
 * the relay coordinates, wires everything up, and starts the bridge.
 *
 *   node bridge/scripts/build-installer.mjs \
 *     --relay wss://8080-<sandbox>.e2b.app/bridge --token <bridge-token>
 *
 * The resulting file is a build artifact: run this again after changing the
 * laptop-side sources so the two cannot drift.
 */

import { gzipSync } from "node:zlib";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(BRIDGE_DIR, "..");
const INSTALLER = join(BRIDGE_DIR, "install.mjs");

const args = parseArgs(process.argv.slice(2));
const relay = args.relay || process.env.EGO_BRIDGE_RELAY;
const token = args.token || process.env.EGO_BRIDGE_TOKEN;
if (!relay || !token) {
  console.error(
    "usage: node bridge/scripts/build-installer.mjs --relay wss://<host>/bridge --token <bridge-token>",
  );
  process.exit(2);
}

const INCLUDE = [
  "bridge/laptop/bridge.mjs",
  "bridge/tasks/_kit.snippet.js",
  "bridge/fixtures/orders-server.mjs",
  "bridge/scripts/laptop-bridge.sh",
  "bridge/tasks/smoke-ego.mjs",
  "bridge/tasks/t1-read-logged-in.mjs",
  "bridge/tasks/t2-interact.mjs",
  "bridge/tasks/t3-search-summarize.mjs",
  "bridge/tasks/t4-multitab.mjs",
  "bridge/tasks/t5-checkout-flow.mjs",
  "bridge/tasks/t6-local-app.mjs",
  "bridge/tasks/t7-handoff.mjs",
];

const files = {};
for (const path of INCLUDE) {
  const absolute = join(REPO_ROOT, path);
  const relativePath = relative("bridge", path).split("\\").join("/");
  try {
    files[relativePath] = await readFile(absolute, "utf8");
  } catch {
    console.error(`missing input file: ${path}`);
    process.exit(2);
  }
}
const taskCount = (await readdir(join(BRIDGE_DIR, "tasks"))).filter((f) => f.endsWith(".mjs")).length;

const payload = gzipSync(Buffer.from(JSON.stringify(files))).toString("base64");
const template = await readFile(join(BRIDGE_DIR, "install.template.mjs"), "utf8");

const output = template
  .replace("__BUNDLE__", () => payload)
  .replace("__RELAY__", () => JSON.stringify(relay))
  .replace("__TOKEN__", () => JSON.stringify(token))
  .replace("__TASKCOUNT__", () => String(taskCount))
  .replace("__BUILTAT__", () => JSON.stringify(new Date().toISOString()));

await writeFile(INSTALLER, output);
console.log(
  `wrote ${relative(REPO_ROOT, INSTALLER)} (${(output.length / 1024).toFixed(0)} KB, ${taskCount} tasks)`,
);
console.log(`relay: ${relay}`);

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
