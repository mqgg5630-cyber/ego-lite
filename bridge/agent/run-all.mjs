#!/usr/bin/env node
/**
 * Run the whole ladder and print a scoreboard.
 *
 *   node bridge/agent/run-all.mjs                       # tiers that need no input
 *   node bridge/agent/run-all.mjs --local http://localhost:3000
 *
 * Tiers that cannot run are reported as SKIP rather than FAIL, because "your
 * laptop has no dev server on 3000" is not a broken tunnel.
 */

const args = parseArgs(process.argv.slice(2));
const relay = (args.relay || process.env.EGO_RELAY_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const token = args.token || process.env.EGO_AGENT_TOKEN || "";
const headers = token ? { authorization: `Bearer ${token}` } : {};

const LADDER = [
  {
    task: "smoke-ego",
    label: "T0 冒烟：ego-browser 与 Space 可用",
    params: {},
    proves: "CLI 应答、p1 可导航、snapshot 有结构",
  },
  {
    task: "t1-read-logged-in",
    label: "T1 读取：本机登录态",
    params: { url: args.url || "https://github.com/notifications" },
    proves: "驱动的是你自己的 profile，不是干净的云浏览器",
  },
  {
    task: "t2-interact",
    label: "T2 交互：填写/选择/点击/等待",
    params: {},
    proves: "指针与键盘层在真浏览器里生效",
  },
  {
    task: "t3-search-summarize",
    label: "T3 判断：检索结果解析 + 打开首条",
    params: { engine: args.engine || "bing", query: args.query || "ego lite browser agent" },
    proves: "外部站点可读，结构解析可用，模型可接手",
  },
  {
    task: "t4-multitab",
    label: "T4 多标签：并行 + 只读你的标签页",
    params: {},
    proves: "多 Page 并发，且不抢你的标签",
  },
  {
    task: "t5-checkout-flow",
    label: "T5 闭环：登录/筛选/分页/下载/解析",
    params: { baseUrl: args.fixture || "http://127.0.0.1:8787" },
    proves: "多步骤业务流的端到端闭环（本地夹具）",
    skipIf: () => (args.fixture === false ? "未启用本地夹具" : null),
  },
  {
    task: "t6-local-app",
    label: "T6 你的电脑：操作本机 localhost 应用",
    params: { url: args.local, screenshot: true },
    proves: "浏览器里的 localhost 就是你的电脑",
    skipIf: () => (args.local ? null : "没有传 --local <本机地址>"),
  },
  {
    task: "t7-handoff",
    label: "T7 协作：交还控制权",
    params: { url: args.url || "https://example.com" },
    proves: "handOff 之后你随时能夺回浏览器",
    note: "只跑前半段；你操作完后用 --resume-space <id> 跑后半段",
  },
];

// Fail fast with one clear message instead of eight identical errors.
const preflight = await fetch(relay + "/api/bridge", { headers })
  .then((r) => r.json())
  .catch(() => null);
if (!preflight?.bridge?.connected) {
  console.error(
    `relay at ${relay} has no laptop bridge connected.\n` +
      "Start it on the laptop:\n" +
      "  bridge/scripts/laptop-bridge.sh wss://<relay-host>/bridge <EGO_BRIDGE_TOKEN>\n" +
      (preflight?.bridge?.hint || ""),
  );
  process.exit(3);
}
console.log(`laptop: ${preflight.bridge.host} · ${preflight.bridge.platform} · ${(preflight.bridge.tasks || []).length} tasks\n`);

const rows = [];
for (const tier of LADDER) {
  const skip = tier.skipIf?.();
  if (skip) {
    rows.push({ ...tier, status: "SKIP", detail: skip });
    console.log(`- ${tier.label}: SKIP (${skip})`);
    continue;
  }
  process.stdout.write(`- ${tier.label} ... `);
  const started = Date.now();
  try {
    const response = await fetch(relay + "/api/run", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ task: tier.task, params: tier.params, timeoutMs: 240_000 }),
    });
    const body = await response.json();
    if (response.status === 202) {
      rows.push({ ...tier, status: "ASYNC", detail: `job ${body.jobId}` });
      console.log(`queued as ${body.jobId}`);
      continue;
    }
    const ok = response.ok && body.result?.ok;
    const remarks = (body.result?.stdout || "")
      .split("\n")
      .filter((line) => line.startsWith("[bridge]"))
      .join(" | ");
    rows.push({
      tier,
      task: tier.task,
      label: tier.label,
      status: ok ? "PASS" : body.status === "failed" ? "FAIL" : "ERROR",
      ms: body.ms ?? Date.now() - started,
      detail:
        remarks ||
        body.error ||
        (body.result?.stderr || "").split("\n").filter(Boolean)[0] ||
        `HTTP ${response.status}`,
    });
    console.log(`${rows.at(-1).status} (${rows.at(-1).ms}ms)`);
    if (rows.at(-1).detail) console.log(`    ${rows.at(-1).detail}`);
    if (!ok && body.result?.stderr) {
      console.log("    stderr: " + body.result.stderr.trimEnd().split("\n").slice(-4).join("\n    "));
    }
  } catch (error) {
    rows.push({
      task: tier.task,
      label: tier.label,
      status: "ERROR",
      detail: String(error.message || error),
    });
    console.log("ERROR " + (error.message || error));
  }
}

const width = Math.max(...rows.map((row) => String(row.label || row.task).length), 10);
console.log("\n=== 打通记分板 ===");
for (const row of rows) {
  const status = String(row.status).padEnd(5);
  console.log(`${status} ${String(row.label || row.task).padEnd(width)}  ${row.detail || ""}`);
}
const passed = rows.filter((row) => row.status === "PASS").length;
const failed = rows.filter((row) => row.status === "FAIL" || row.status === "ERROR").length;
console.log(`\n${passed} passed, ${failed} failed, ${rows.filter((r) => r.status === "SKIP").length} skipped`);
process.exit(failed === 0 ? 0 : 1);

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
