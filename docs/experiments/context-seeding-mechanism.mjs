/**
 * Does a browser-level Storage.setCookies with browserContextId reach an
 * isolated context's cookie jar?
 *
 * Connects straight to Chrome's DevTools browser endpoint, bypassing the
 * harness's CDP routing, which only promotes Target and Browser domain calls to
 * the browser level and would otherwise send Storage calls to a page session.
 * Touches no files in package/ego-linux.
 *
 * Uses a synthetic cookie only — no real credentials are moved.
 */
import { execSync } from "node:child_process";

const status = JSON.parse(execSync("ego-browser --status", { encoding: "utf8" }));
if (!status.running) throw new Error("browser is not running");

const ws = new WebSocket(status.wsUrl);
let nextId = 1;
const pending = new Map();

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => pending.has(id) && reject(new Error(`timeout: ${method}`)), 15000);
  });

await new Promise((r) => ws.addEventListener("open", r, { once: true }));
console.log("connected to browser endpoint\n");

const marker = "egoctx" + String(Date.now()).slice(-6);
const { browserContextId } = await send("Target.createBrowserContext", {});
console.log("isolated context:", browserContextId.slice(0, 12) + "…");

let verdict = "unknown";
try {
  // 1. browser-level read, scoped to the new context
  const before = await send("Storage.getCookies", { browserContextId });
  console.log("1. cookies in fresh context:", before.cookies.length, "(0 = scoping works)");

  // 2. browser-level write, scoped to the new context
  await send("Storage.setCookies", {
    browserContextId,
    cookies: [{ name: marker, value: "seeded", domain: "example.com", path: "/" }],
  });
  const after = await send("Storage.getCookies", { browserContextId });
  const landed = after.cookies.some((c) => c.name === marker);
  console.log("2. after scoped setCookies:", after.cookies.length, "cookie(s), marker present:", landed);

  // 3. does a real page inside that context actually see it?
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: "https://example.com" }, sessionId);
  await new Promise((r) => setTimeout(r, 3000));
  const seen = await send("Runtime.evaluate", { expression: "document.cookie", returnByValue: true }, sessionId);
  const pageSees = String(seen.result.value).includes(marker);
  console.log("3. page inside the context sees it:", pageSees);

  // 4. default context must stay clean
  const dflt = await send("Storage.getCookies", {});
  const leaked = dflt.cookies.some((c) => c.name === marker);
  console.log("4. leaked into default context:", leaked, "(false = still isolated)");

  verdict =
    landed && pageSees && !leaked
      ? "SEEDING WORKS — isolation + inherited logins, no Chromium fork needed"
      : `seeding incomplete (landed=${landed} pageSees=${pageSees} leaked=${leaked})`;
} finally {
  await send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  console.log("\ncontext disposed");
  ws.close();
}

console.log("VERDICT:", verdict);
