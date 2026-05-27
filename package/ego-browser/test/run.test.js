import assert from "node:assert/strict";
import test from "node:test";

import { installEgoSdk } from "../dist/src/index.js";
import { executionContext, runMain } from "../dist/src/run.js";

function output() {
  let text = "";
  return {
    stream: { write: (chunk) => { text += chunk; } },
    text: () => text
  };
}

function services(overrides = {}) {
  return {
    resetConnection: async () => {},
    printUpdateBanner: () => {},
    runDoctor: async () => 0,
    ...overrides
  };
}

test("stdin JavaScript executes with camelCase helpers in scope", async () => {
  const out = output();
  const code = await runMain({
    argv: [],
    stdinText: "cliLog(typeof newTab, typeof new_tab, typeof pageInfo, typeof page_info, typeof runDoctor, typeof run_doctor)",
    stdout: out.stream,
    stderr: output().stream,
    services: services()
  });

  assert.equal(code, 0);
  assert.equal(out.text(), "function undefined function undefined undefined undefined\n");
});

test("non-stdin arguments are rejected with usage", async () => {
  const err = output();
  const code = await runMain({
    argv: ["-c", "cliLog('old path')"],
    stdinText: "cliLog('ignored')",
    stdout: output().stream,
    stderr: err.stream,
    services: services()
  });

  assert.equal(code, 2);
  assert.match(err.text(), /ego-browser <<'JS'/);
});

test("runMain --reload uses resetConnection and prints the browser reset message", async () => {
  const calls = [];
  const out = output();
  const code = await runMain({
    argv: ["--reload"],
    stdout: out.stream,
    stderr: output().stream,
    services: services({
      resetConnection: async () => {
        calls.push("reset");
      }
    })
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["reset"]);
  assert.equal(out.text(), "browser connection reset on next call\n");
});

test("executionContext exposes camelCase helpers for sdk loading", async () => {
  const writes = [];
  const context = await executionContext({ write: (chunk) => writes.push(chunk) });

  assert.equal(typeof context.newTab, "function");
  assert.equal(typeof context.waitForLoad, "function");
  assert.equal(typeof context.pageInfo, "function");
  assert.equal(typeof context.openOrReuseTab, "function");
  assert.equal(typeof context.gotoAndWait, "function");
  assert.equal(typeof context.snapshot, "function");
  assert.equal(typeof context.snapshotText, "function");
  assert.equal(typeof context.click, "function");
  assert.equal(typeof context.fill, "function");
  assert.equal(typeof context.taskSpaces, "function");
  assert.equal(typeof context.useOrCreateTaskSpace, "function");
  assert.equal(typeof context.cdp, "function");
  assert.equal(typeof context.js, "function");
  assert.equal(context.new_tab, undefined);

  context.cliLog("ok", { ready: true });
  assert.deepEqual(writes, ['ok {"ready":true}\n']);
});

test("executionContext omits testing internals and private exports", async () => {
  const context = await executionContext({ write() {} });
  assert.equal(context.__testing, undefined);
  assert.equal(context._private, undefined);
});

test("installEgoSdk gates helpers on explicit readiness", async () => {
  const calls = [];
  const target = {};
  let releaseReady;
  const ready = new Promise((resolve) => {
    releaseReady = resolve;
  });

  installEgoSdk(target, {
    ready,
    context: {
      newTab: async (url) => {
        calls.push(["newTab", url]);
        return "target-1";
      }
    },
    cliLog: (...args) => calls.push(["cliLog", ...args])
  });

  const opened = target.newTab("https://zhihu.com");
  assert.deepEqual(calls, []);
  releaseReady();
  assert.equal(await opened, "target-1");
  assert.deepEqual(calls, [["newTab", "https://zhihu.com"]]);
  target.cliLog("ok");
  assert.deepEqual(calls.at(-1), ["cliLog", "ok"]);
});
