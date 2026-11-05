// @title: 冒烟 — ego-browser 与 Space 是否可用
// @params: {} 不需要参数
// @checks: taskSpace 能创建/恢复、spaceId 稳定、Page p1 能导航、snapshot 能返回结构
//
// Tier 0. Nothing about "your computer" is proven until this passes: it proves
// the laptop's ego-browser CLI answers the bridge and can drive its own Chromium.
//#include task-kit

const name = `bridge-smoke`;

const task = await taskSpace(name);
const page = task.page("p1");

remark(`space=${task.spaceId} label=${page.label}`);
const before = await page.url().catch(() => "about:blank");

await page.goto("https://example.com", { timeout: 30_000 });
await page.waitForSelector("h1", { state: "visible", timeout: 15_000 });

const title = await page.title();
const heading = await page.evaluate(() => document.querySelector("h1")?.textContent?.trim());
const snapshot = await page.snapshot();

const result = {
  spaceId: task.spaceId,
  page: page.label,
  entryUrl: before,
  title,
  heading,
  snapshotLines: String(snapshot).split("\n").length,
  egoRuntime: typeof globalThis.ego === "object",
};

console.log(JSON.stringify(result, null, 2));
console.log("SNAPSHOT-START");
console.log(snapshot);
console.log("SNAPSHOT-END");

remark(`smoke ok: heading="${heading}" title="${title}"`);

// Keep the space for the next tier: this task runs repeatedly while the user
// diagnoses. Tiers that finish a real goal call finish() themselves.
