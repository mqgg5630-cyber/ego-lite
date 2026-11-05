// @title: T5 闭环 — 多步骤业务流（本地夹具，零外部依赖）
// @params: {} 不需要参数
// @checks: 登录态校验 → 筛选 → 分页 → 汇总 → 下载 CSV → 解析下载文件
//
// Tier 5. A short but *complete* workflow, modelled on the real jobs people
// hand an agent: log in with a session that is already there, filter, page
// through, totals, download a file, parse it. It runs against the local fixture
// server (bridge/fixtures) so it is reproducible offline and cannot touch the
// user's real accounts.
//#include task-kit

const base = params.baseUrl || "http://127.0.0.1:8787";
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");

const task = await taskSpace("bridge-t5-workflow");
const page = task.page("p1");

await page.goto(base + "/", { timeout: 15_000 });
await page.waitForSelector("#login", { state: "visible", timeout: 10_000 });

// The fixture signs in with a fake session cookie, mimicking "already logged in".
await page.fill("#email", params.email || "buyer@example.test");
await page.click("#login button[type=submit]", { label: "sign in to fixture" });
await page.waitForSelector("#orders", { state: "visible", timeout: 10_000 });

await page.selectOption("#status", { label: "Paid" });
await page.waitForFunction(() => document.querySelectorAll("#rows tr").length > 0, undefined, {
  timeout: 10_000,
});

const rows = [];
for (let guard = 0; guard < 10; guard += 1) {
  const pageRows = await page.evaluate(() =>
    [...document.querySelectorAll("#rows tr")].map((tr) => ({
      id: tr.children[0].innerText.trim(),
      customer: tr.children[1].innerText.trim(),
      total: Number(tr.children[2].innerText.replace(/[^0-9.]/g, "")),
    })),
  );
  rows.push(...pageRows);
  const next = await page.evaluate(() => {
    const button = document.querySelector("#next");
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });
  if (!next) break;
  await page.waitForTimeout(300);
}

const total = rows.reduce((sum, row) => sum + row.total, 0);
console.log(JSON.stringify({ orders: rows.length, total, rows: rows.slice(0, 5) }, null, 2));

// A real download: arm the wait before clicking, then save and parse it.
const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
await page.click("#export", { label: "export paid orders" });
const download = await downloadPromise;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-bridge-dl-"));
const saved = path.join(dir, download.suggestedFilename());
await download.saveAs(saved);
const csv = await fs.readFile(saved, "utf8");
const lines = csv.trim().split("\n");

console.log("DOWNLOAD");
console.log(
  JSON.stringify(
    {
      suggestedFilename: download.suggestedFilename(),
      saved,
      bytes: csv.length,
      dataLines: lines.length - 1,
      header: lines[0],
      matchesScrapedTotal: Math.abs(
        lines
          .slice(1)
          .reduce((sum, line) => sum + Number(line.split(",").pop() || 0), 0) - total,
      ) < 0.01,
    },
    null,
    2,
  ),
);

remark(
  `workflow tier: ${rows.length} rows totalling ${total.toFixed(2)}, CSV downloaded and parsed (${lines.length - 1} data lines)`,
);

await task.finish({ keep: [] });
