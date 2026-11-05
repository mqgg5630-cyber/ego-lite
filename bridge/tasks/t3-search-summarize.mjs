// @title: T3 判断 — 带模型的检索与总结（可选）
// @params: { "engine": "bing" | "duckduckgo" | "google", "query": string }
// @checks: 搜索结果页结构解析 → 前 N 条标题/链接 → 打开第一条并取正文摘要
//
// Tier 3. This is the first tier where an LLM is involved: the task gathers
// candidates and returns them, and the agent (in the cloud) decides what they
// mean. Keeping the model out of the task makes the tier deterministic and
// cheap to rerun.
//#include task-kit

const engine = params.engine || "bing";
const query = params.query || "ego lite browser agent";

const SEARCH = {
  bing: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  duckduckgo: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
};

const task = await taskSpace("bridge-t3-search");
const page = task.page("p1");

await page.goto(SEARCH[engine], { timeout: 45_000 });
await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});

const candidates = await page.evaluate((sel) => {
  const nodes = [...document.querySelectorAll(sel)];
  return nodes.slice(0, 8).map((node) => {
    const link = node.querySelector("a[href^='http']");
    return {
      title: (node.querySelector("h2, h3")?.innerText || node.innerText || "").trim().slice(0, 160),
      href: link ? link.href : null,
    };
  });
}, engine === "duckduckgo" ? ".result" : engine === "google" ? "div.g, .MjjYud" : "li.b_algo");

const usable = candidates.filter((item) => item.href && item.title);
console.log(JSON.stringify({ engine, query, found: usable.length, candidates: usable }, null, 2));

if (usable.length > 0) {
  const first = usable[0];
  await page.goto(first.href, { timeout: 45_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
  const excerpt = await page.evaluate(() => {
    const paragraphs = [...document.querySelectorAll("p")]
      .map((node) => node.innerText.trim())
      .filter((text) => text.length > 60);
    return {
      title: document.title,
      url: location.href,
      excerpt: paragraphs.slice(0, 3).join("\n\n").slice(0, 1200),
    };
  });
  console.log("FIRST-RESULT");
  console.log(JSON.stringify(excerpt, null, 2));
  remark(`judgment tier: ok — ${usable.length} results, opened "${excerpt.title}"`);
} else {
  remark(
    `judgment tier: BLOCKED — ${engine} returned no parseable results (captcha, consent wall, or markup change)`,
  );
}

await task.finish({ keep: [] });
