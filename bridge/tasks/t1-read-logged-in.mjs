// @title: T1 读取 — 用本机登录态的数据看一个真实页面
// @params: { url?: string } 默认 https://github.com/notifications （用你的 GitHub 登录态）
// @checks: 复用用户已登录 profile → 能读到登录后才可见的内容 → 证明"访问你的数据"这条链路通
//
// Tier 1. The whole point of ego-lite over a remote browser is that the agent
// reaches the user's real cookies. This task proves only that: it reads a page
// that is different when logged out, and reports which case it hit. It never
// writes anything.
//#include task-kit

const url = params.url || "https://github.com/notifications";
const SIGNED_OUT = [
  "Sign in to GitHub",
  "Sign in to view",
  "You must be signed in",
];

const task = await taskSpace("bridge-t1-read");
const page = task.page("p1");

await page.goto(url, { timeout: 45_000 });
await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});

const probe = await page.evaluate(() => {
  const body = document.body ? document.body.innerText : "";
  const links = [...document.querySelectorAll("a[href]")]
    .map((a) => a.getAttribute("href"))
    .filter(Boolean);
  return {
    title: document.title,
    path: location.pathname,
    firstChars: body.slice(0, 600),
    length: body.length,
    hasDashboardLink: links.some((href) => href === "/dashboard"),
    hasLoginLink: links.some((href) => /\/login/.test(href)),
    notificationRows: document.querySelectorAll(
      '[data-testid="notification-list-item"], .notifications-list-item, [class*="notification"] article',
    ).length,
  };
});

const signedOut =
  /\/login|\/session/.test(probe.path) ||
  SIGNED_OUT.some((marker) => probe.title.includes(marker) || probe.firstChars.includes(marker)) ||
  (probe.hasLoginLink && !probe.hasDashboardLink);

const report = {
  url,
  title: probe.title,
  path: probe.path,
  signedIn: !signedOut,
  notificationRows: probe.notificationRows,
  visibleChars: probe.length,
};
console.log(JSON.stringify(report, null, 2));

if (signedOut) {
  remark(
    "read tier: SIGNED OUT — ego-browser is driving a profile without your cookies. " +
      "Fix: open ego lite, complete the Chrome-data import during onboarding (or sign in once in your Space), then rerun.",
  );
} else {
  remark(`read tier: ok — reached logged-in view of ${probe.path}, ${probe.length} chars of body text`);
}

// Reading tier keeps its page so the user can look at it in ego lite's Space.
console.log("PAGEURL " + (await page.url()));
