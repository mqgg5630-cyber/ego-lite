// @title: T6 你的电脑 — 操作本机 localhost 上的应用
// @params: { "url": "http://localhost:3000" } 必填：你本机正在跑的东西
// @checks: 从浏览器侧访问本机端口（localhost 不是云端的 loopback）→ 元素/截图
//
// Tier 6. This is the capability no cloud browser has: the Page runs on the
// laptop, so `localhost` means *your* machine. Point it at a dev server, an
// admin panel, Jupyter, Grafana, Home Assistant, Odoo — anything you have
// running locally.
//#include task-kit

const url = params.url;
if (!url) {
  throw new Error(
    't6-local-app needs params.url, e.g. {"url":"http://localhost:3000"} — tell me which local app to open.',
  );
}

const task = await taskSpace("bridge-t6-localapp");
const page = task.page("p1");

await page.goto(url, { timeout: 30_000 });
await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});

const look = await page.evaluate(() => ({
  title: document.title,
  url: location.href,
  h1: document.querySelector("h1")?.innerText?.trim() || null,
  interactive: document.querySelectorAll("button, a, input, select, textarea").length,
  textSample: document.body.innerText.slice(0, 800),
}));

console.log(JSON.stringify(look, null, 2));

// Only capture a screenshot when asked: the visual layer is where local apps
// differ most (canvas, embedded players, custom widgets).
if (params.screenshot) {
  const capture = await shot(page, "t6-local-app");
  console.log(JSON.stringify({ screenshot: capture }, null, 2));
}

// Optional keystrokes, so a user can prove input reaches the local app.
if (params.keys) {
  await page.keyboard.press(params.keys);
  remark(`sent key ${params.keys} to ${localSafe(url)}`);
  await page.waitForTimeout(500);
  console.log("AFTER-KEY", JSON.stringify(await page.evaluate(() => location.href)));
}

function localSafe(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "local app";
  }
}

remark(
  `local-app tier: opened ${look.url} ("${look.title}"), ${look.interactive} interactive elements reachable`,
);

await task.finish({ keep: [] });
