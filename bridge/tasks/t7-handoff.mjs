// @title: T7 协作 — 把浏览器交还给你，再拿回来
// @params: { "url"?: string } 默认打开一个需要真人才能过的页面
// @checks: handOff() 真正让出控制、waitForControl() 能在你操作后继续
//
// Tier 7. The collaboration tier: the agent stops where a human is required
// (2FA, captcha, payment confirmation, device chooser) and resumes afterwards.
// This is the tier that makes "my computer" safe rather than scary: the agent
// can always be pushed out of the way.
//#include task-kit

const url = params.url || "https://example.com";

const task = await taskSpace("bridge-t7-handoff");
const page = task.page("p1");
await page.goto(url, { timeout: 30_000 });

remark(`handing control of space ${task.spaceId} to the user; do your thing in ego lite, then rerun this task with {\"resume\":true}`);
await task.handOff();

// After handOff a later round resumes the same space with takeOverTaskSpace()
// and calls the same task with {"resume":true}. Reaching this branch proves the
// round trip: the user had control, and the agent can take it back.
if (params.resume) {
  const resumed = await takeOverTaskSpace(task.spaceId);
  const userPage = resumed.userPage();
  const view = userPage ? await userPage.url() : null;
  console.log(JSON.stringify({ spaceId: resumed.spaceId, userPageUrl: view }, null, 2));
  remark(`collaboration tier: ok — resumed space ${resumed.spaceId}, user page at ${view}`);
  await resumed.finish({ keep: [] });
} else {
  console.log(
    JSON.stringify(
      {
        awaitingUser: true,
        spaceId: task.spaceId,
        next: `rerun task t7-handoff with {"resume":true} after you have touched the browser`,
      },
      null,
      2,
    ),
  );
}
