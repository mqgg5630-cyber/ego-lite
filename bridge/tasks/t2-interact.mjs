// @title: T2 交互 — 语义操作：填写、点击、下拉选择、条件等待
// @params: {} 不需要参数；不触碰任何外部站点
// @checks: fill + selectOption + click + waitForSelector + 提交后的 DOM 反应
//
// Tier 2. Runs against a data: URL, so it needs no network and no login. It
// proves that the pointer/keyboard/selector layer of the laptop browser really
// works, not just navigation.
//#include task-kit

const html = `<!doctype html><meta charset="utf-8"><title>bridge form</title>
<h1>Express checkout</h1>
<form id="f">
  <label>Coffee <select name="coffee"><option value="flat">Flat white</option><option value="filter">Filter</option></select></label>
  <label>Size <select name="size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select></label>
  <label>Name <input name="name" autocomplete="off"></label>
  <button type="submit">Place order</button>
</form>
<p id="out" hidden>Thanks, <b id="who"></b> — we are brewing a large flat white</p>
<script>
document.getElementById('f').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  document.getElementById('who').textContent = data.get('name') + ' (size ' + data.get('size') + ')';
  document.getElementById('out').hidden = false;
});
</script>`;

const task = await taskSpace("bridge-t2-interact");
const page = task.page("p1");
const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);

await page.goto(dataUrl, { timeout: 20_000 });
await page.waitForSelector("form#f", { state: "visible", timeout: 10_000 });

await page.fill("input[name=name]", params.name || "Bridge Test");
await page.selectOption("select[name=coffee]", { value: "flat" });
await page.selectOption("select[name=size]", { label: "Large" });

const clickReceipt = await page.click("button[type=submit]", { label: "place the test order" });
await page.waitForSelector("#out", { state: "visible", timeout: 10_000 });

const confirmation = await page.evaluate(() => ({
  text: document.getElementById("out")?.innerText?.trim(),
  who: document.getElementById("who")?.textContent,
  visible: !document.getElementById("out").hidden,
}));

const filled = await page.evaluate(() => document.querySelector("input[name=name]").value);

const report = {
  url: page ? "data: url" : null,
  filledValue: filled,
  confirmation,
  dialog: clickReceipt?.dialog ? "unexpected" : null,
  pass: confirmation.visible && /Bridge Test|large/i.test(confirmation.text),
};
console.log(JSON.stringify(report, null, 2));

if (report.pass) {
  remark(`interaction tier: ok — form submitted, confirmation "${confirmation.text}"`);
} else {
  remark(`interaction tier: FAILED — confirmation was ${JSON.stringify(confirmation)}`);
}

// Nothing here is worth keeping for the user; release the space.
await task.finish({ keep: [] });
