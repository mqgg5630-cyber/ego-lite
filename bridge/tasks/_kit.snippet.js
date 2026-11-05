/**
 * Shared helpers spliced into bridge tasks by bridge/laptop/bridge.mjs.
 *
 * Tasks are single files (ego-browser scripts cannot import local modules), so
 * a task writes `//#include task-kit` on its own line and the bridge replaces
 * that line with this file. Nothing here is imported at runtime.
 */
/** Print a line the agent is expected to grep for in the job output. */
function remark(line) {
  console.log("[bridge] " + line);
}

/**
 * Upload a PNG to the relay so the agent can look at it, and return the URL.
 * Requires globalThis.__relay.captureToken, which the relay issues per job.
 */
async function shot(page, name) {
  const relay = globalThis.__relay || {};
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ego-shot-"));
  const file = path.join(dir, name + ".png");
  await page.screenshot({ path: file });
  if (!relay.url || !relay.captureToken) {
    console.log("[bridge] shot saved locally only: " + file);
    return { url: null, local: file };
  }
  const bytes = await fs.readFile(file);
  const res = await fetch(relay.url + "/api/tasks/shots/" + name + ".png", {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-ego-shot-token": relay.captureToken,
    },
    body: bytes,
  });
  const body = await res.json().catch(() => ({}));
  console.log("[bridge] shot " + name + " -> " + (body.url || res.status));
  return { url: body.url || null, local: file, status: res.status };
}
