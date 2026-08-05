/**
 * Production-scale check: can a fresh isolated context be seeded with the whole
 * real cookie jar? Counts only — no cookie values are printed, no authenticated
 * page is loaded, and the context is disposed immediately.
 */
import { execSync } from "node:child_process";

const status = JSON.parse(execSync("ego-browser --status", { encoding: "utf8" }));
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

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && reject(new Error(`timeout: ${method}`)), 30000);
  });

await new Promise((r) => ws.addEventListener("open", r, { once: true }));

const source = await send("Storage.getCookies", {});
console.log("real jar:", source.cookies.length, "cookies");

const { browserContextId } = await send("Target.createBrowserContext", {});
try {
  const t0 = Date.now();
  await send("Storage.setCookies", { browserContextId, cookies: source.cookies });
  const ms = Date.now() - t0;

  const seeded = await send("Storage.getCookies", { browserContextId });
  const names = new Set(seeded.cookies.map((c) => c.name + "|" + c.domain));
  const wanted = new Set(source.cookies.map((c) => c.name + "|" + c.domain));
  const missing = [...wanted].filter((k) => !names.has(k)).length;

  console.log("seeded:", seeded.cookies.length, "of", source.cookies.length, `in ${ms}ms`);
  console.log("distinct name+domain not carried over:", missing);

  const dflt = await send("Storage.getCookies", {});
  console.log("default jar unchanged:", dflt.cookies.length === source.cookies.length);
  console.log(
    "\nVERDICT:",
    seeded.cookies.length >= source.cookies.length * 0.95
      ? "SCALES — the real login state transfers into an isolated context"
      : "partial transfer, needs investigation",
  );
} finally {
  await send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  console.log("context disposed");
  ws.close();
}
