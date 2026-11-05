// @title: T4 多标签 — 跨页收集 + 回到用户自己的标签页（只读）
// @params: {} 不需要参数
// @checks: newPage 并行、多标签聚合、tabs()/adopt 读取用户标签、全程不写
//
// Tier 4. Two things separate ego-lite from a headless scraper: agents run
// several Pages at once, and they can *see* the tabs the human already has
// open without stealing them. This tier exercises both, read-only.
//#include task-kit

const task = await taskSpace("bridge-t4-multitab");

const urls = [
  "https://example.com",
  "https://www.iana.org/help/example-domains",
  "https://httpbin.org/html",
];

const pages = [];
for (let i = 0; i < urls.length; i += 1) {
  pages.push(i === 0 ? task.page("p1") : await task.newPage());
}

const collected = await Promise.all(
  pages.map(async (page, index) => {
    const url = urls[index];
    try {
      await page.goto(url, { timeout: 40_000 });
      const info = await page.evaluate(() => ({
        title: document.title,
        h1: document.querySelector("h1")?.innerText?.trim() || null,
        chars: document.body.innerText.length,
      }));
      return { url, label: page.label, ok: true, ...info };
    } catch (error) {
      return { url, label: page.label, ok: false, error: String(error.message || error) };
    }
  }),
);

console.log("COLLECTED");
console.log(JSON.stringify(collected, null, 2));

// Now look at the human's side: list every tab in this space and adopt one that
// the user opened. Read-only, and released immediately after reading.
const tabs = await task.tabs();
const userTab = tabs.find((tab) => !tab.label && tab.openedBy === "unknown" && tab.url?.startsWith("http"));
const userView = userTab
  ? {
      adopted: true,
      url: userTab.url,
      title: (await task.adopt(userTab.page)).title(),
    }
  : { adopted: false, note: "no user-owned tab in this space to read" };

console.log("USER-TAB");
console.log(JSON.stringify({ tabCount: tabs.length, ...userView }, null, 2));

const okPages = collected.filter((item) => item.ok).length;
remark(
  `multitab tier: ${okPages}/${urls.length} pages read in parallel; ` +
    `${userView.adopted ? "read a user tab without taking it" : "no user tab present"}`,
);

await task.finish({ keep: [] });
