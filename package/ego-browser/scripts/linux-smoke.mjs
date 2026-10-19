#!/usr/bin/env node
// Isolated real-Chrome contract checks. Never attaches to a personal browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

const headed = process.argv.includes("--headed");
const root = await mkdtemp(join(tmpdir(), "ego-linux-smoke-"));
const cli = resolve("dist/out/index.js");
const env = {
  ...process.env,
  EGO_LINUX_STATE_DIR: root,
  EGO_BROWSER_STATE_DIR: join(root, "ledger"),
  EGO_BROWSER_AGENT_WORKSPACE: root,
  EGO_LINUX_HEADLESS: headed ? "0" : "1",
  EGO_LINUX: "1",
};
delete env.EGO_LINUX_PORT;
let xvfb;
let finalReport;
const server = createServer((request, response) => {
  if (request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end(
    '<!doctype html><title>Linux fixture</title><main><button id="continue" onclick="this.textContent=\'Clicked\'">Continue</button><section id="below" style="margin-top:2500px"><button>Offscreen</button></section></main>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
function run(code, args = ["nodejs"], overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...env, ...overrides },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${stderr}`));
    }, 45_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status) reject(new Error(`CLI exit ${status}: ${stderr}\n${stdout}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(code);
  });
}
function result(text) {
  return JSON.parse(text.split("\n").find((line) => line.startsWith("{")));
}
try {
  if (headed) {
    xvfb = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
      { stdio: ["ignore", "ignore", "pipe", "pipe"] },
    );
    const display = await Promise.race([
      once(xvfb.stdio[3], "data").then(([data]) => data.toString().trim()),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Xvfb startup timed out")),
          5000,
        ).unref(),
      ),
    ]);
    env.DISPLAY = `:${display}`;
    delete env.WAYLAND_DISPLAY;
  }
  assert.match(await run("", ["skill"]), /\[ego-browser:skill\] end of guide/);
  assert.equal(await run('console.log("nodejs works")'), "nodejs works");
  assert.equal(
    await run("console.log(Boolean(globalThis.ego))", ["nodejs"], {
      EGO_LINUX: undefined,
      CI: "",
      NODE_TEST_CONTEXT: undefined,
    }),
    "true",
  );
  await Promise.all(
    Array.from({ length: 3 }, () =>
      run("console.log(JSON.stringify(await ego.listProfiles()))").then(
        (text) => assert.equal(result(text).profiles[0].id, "Default"),
      ),
    ),
  );
  // Activation is supplied only by the workspace .env, after static imports.
  await writeFile(join(root, ".env"), "EGO_LINUX=1\n");
  const a = result(
    await run(
      `const task = await taskSpace('isolation-a'); const page = task.page('p1'); await page.goto(${JSON.stringify(url)}); await page.evaluate(() => { document.cookie = 'probe=a'; localStorage.probe = 'a'; }); console.log(JSON.stringify({id:task.id, target:(await ego.listTabs()).tabs[0].targetId, snapshot:await page.snapshot({scope:'full_page'})}));`,
      ["nodejs"],
      { EGO_LINUX: undefined },
    ),
  );
  assert.match(a.snapshot, /Continue/);
  const b = result(
    await run(
      `const task = await taskSpace('isolation-b'); const page = task.page('p1'); await page.goto(${JSON.stringify(url)}); console.log(JSON.stringify({id:task.id,target:(await ego.listTabs()).tabs[0].targetId,cookie:await page.evaluate(() => document.cookie),storage:await page.evaluate(() => localStorage.getItem("probe"))}));`,
    ),
  );
  assert.equal(b.cookie, "");
  assert.equal(b.storage, null);
  assert.notEqual(a.id, b.id);
  const persisted = result(
    await run(
      `const task = await taskSpace(${a.id}); const page = task.page('p1'); console.log(JSON.stringify({cookie:await page.evaluate(() => document.cookie),storage:await page.evaluate(() => localStorage.getItem("probe")),snapshot:await page.snapshot({scope:'only_within_viewport'})}));`,
    ),
  );
  assert.equal(persisted.cookie, "probe=a");
  assert.equal(persisted.storage, "a");
  assert.doesNotMatch(persisted.snapshot, /Offscreen/);
  const clickRef = a.snapshot
    .split("\n")
    .find((line) => line.includes('"Continue"'))
    .match(/\[ref=(\d+)/)[1];
  assert.equal(
    await run(
      `const task=await taskSpace(${a.id});const page=task.page('p1');await page.click('@${clickRef}');console.log(await page.evaluate(()=>document.querySelector('#continue').textContent));`,
    ),
    "Clicked",
  );
  const protocol = result(
    await run(`
    ego.useTaskSpace(${a.id});
    let next=0; const pending=new Map();
    const raw=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ego.sendCDPMessage(JSON.stringify({id,method,params,sessionId}));});
    let accepted;
    ego.onCDPMessage=text=>{const m=JSON.parse(text);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Page.javascriptDialogOpening'){accepted=raw('Page.handleJavaScriptDialog',{accept:true},m.sessionId);}};
    ego.onSendCDPMessageError=(message,code)=>{for(const p of pending.values())p.reject(new Error(code));pending.clear();};
    const {sessionId}=await raw('Target.attachToTarget',{targetId:${JSON.stringify(a.target)}});
    await raw('Page.enable',{},sessionId);
    const dialog=await raw('Runtime.evaluate',{expression:"alert('fixture'); 42",returnByValue:true},sessionId);await accepted;
    const separate=await Promise.allSettled([raw('DOM.thisMethodDoesNotExist',{},sessionId),raw('Runtime.evaluate',{expression:'2+2',returnByValue:true},sessionId)]);
    console.log(JSON.stringify({dialog:dialog.result.value,invalid:separate[0].status,valid:separate[1].value?.result.value}));
  `),
  );
  assert.deepEqual(protocol, { dialog: 42, invalid: "rejected", valid: 4 });
  const security = result(
    await run(
      `ego.useTaskSpace(${a.id}); const raw = (method, params={}, sessionId) => new Promise(resolve => { ego.onCDPMessage = msg => resolve(JSON.parse(msg)); ego.onSendCDPMessageError = (message,error_code) => resolve({error_code}); ego.sendCDPMessage(JSON.stringify({id:1,method,params,sessionId})); }); const foreign=await raw('Target.attachToTarget',{targetId:${JSON.stringify(b.target)}}); const own=await raw('Target.attachToTarget',{targetId:${JSON.stringify(a.target)}}); const escape=await raw('Target.exposeDevToolsProtocol',{targetId:${JSON.stringify(a.target)}},own.result.sessionId); console.log(JSON.stringify({foreign,escape}));`,
    ),
  );
  assert.equal(security.foreign.error_code, "EGO_WEB_CONTENTS_UNAVAILABLE");
  assert.equal(security.escape.error_code, "EGO_CDP_SEND_FAILED");
  if (headed) {
    const handoff = result(
      await run(
        `ego.useTaskSpace(${a.id}); await ego.handOffTaskSpace(); const tabs=await ego.listTabs(); let snapshotCode; try { await ego.snapshot(); } catch(e) { snapshotCode=e.error_code; } const raw=await new Promise(resolve=>{ego.onSendCDPMessageError=(_m,error_code)=>resolve(error_code);ego.sendCDPMessage(JSON.stringify({id:1,method:'Browser.getVersion'}));}); console.log(JSON.stringify({tabs:tabs.error_code,snapshot:snapshotCode,raw}));`,
      ),
    );
    assert.deepEqual(
      Object.values(handoff),
      Array(3).fill("EGO_TASK_SPACE_USER_IN_CONTROL"),
    );
    const resumed = result(
      await run(
        `ego.useTaskSpace(${a.id}); const before=await ego.listTabs(); await ego.takeOverTaskSpace(); const tabs=await ego.listTabs(); await ego.completeTaskSpace(); const spaces=await ego.listTaskSpaces(); console.log(JSON.stringify({before:before.error_code,count:tabs.tabs.length,kept:spaces.taskSpaces.find(s=>s.id===${a.id}).ownership}));`,
      ),
    );
    assert.equal(resumed.before, "EGO_TASK_SPACE_USER_IN_CONTROL");
    assert.equal(resumed.count, 1);
    assert.equal(resumed.kept, "user");
  } else {
    const retained = result(
      await run(
        `const task=await taskSpace(${a.id}); await (await task.newPage()).goto(${JSON.stringify(url)}); let denied=false; try { await task.finish({keep:['p1']}); } catch(e) { denied=/headed Linux host/.test(e.message); } console.log(JSON.stringify({denied,count:(await ego.listTabs()).tabs.length}));`,
      ),
    );
    assert.deepEqual(retained, { denied: true, count: 2 });
    assert.match(
      await run(
        `ego.useTaskSpace(${a.id}); console.log(JSON.stringify(await ego.handOffTaskSpace()));`,
      ),
      /headed Linux host/,
    );
  }
  await run(
    `await ego.claimTaskSpace(${a.id}); ego.useTaskSpace(${a.id}); await ego.closeTaskSpace(); ego.useTaskSpace(${b.id}); await ego.closeTaskSpace(); console.log(JSON.stringify(await ego.listTaskSpaces()));`,
  ).then((text) => assert.deepEqual(result(text), { taskSpaces: [] }));
  finalReport = {
    status: "passed",
    mode: headed ? "headed-xvfb" : "headless",
    checks: [
      "skill/nodejs",
      ".env activation",
      "cross-process labels/state",
      "cookie/storage isolation",
      "snapshot refs/viewport",
      "foreign target and browser-channel rejection",
      "handoff boundary",
      "dialog command concurrency",
      "protocol error isolation",
      "cleanup",
    ],
  };
} finally {
  try {
    await run("", ["stop"]);
  } catch (error) {
    console.error(`Host cleanup: ${error.message}`);
    process.exitCode = 1;
  }
  await new Promise((resolve) => server.close(resolve));
  if (xvfb) {
    const exit = once(xvfb, "exit");
    xvfb.kill("SIGTERM");
    await exit;
  }
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

if (!process.exitCode) console.log(JSON.stringify(finalReport));
