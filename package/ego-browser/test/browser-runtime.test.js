import assert from "node:assert/strict";
import test from "node:test";

import { installEgoSdk } from "../dist/src/index.js";
import { browserCdp, browserEgo, browserSnapshotRefsToRefMap } from "../dist/src/browser-runtime.js";
import * as helpers from "../dist/src/helpers.js";
import { cdp } from "../dist/src/cdp-eval.js";
import { RefMap } from "../dist/src/ref-map.js";

function withBrowserRuntime(runtime, fn) {
  const previous = globalThis.ego;
  globalThis.ego = runtime;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("installEgoSdk organizes ego into runtime, helpers, and learnings", async () => {
  const target = { ego: { sendCDPMessage() {}, createTab() {} } };

  await withBrowserRuntime(target.ego, async () => {
    installEgoSdk(target, {
      ready: undefined,
      context: {
        newTab: async (url) => `opened:${url}`,
        click: async () => {}
      },
      cliLog() {}
    });
    // helpers accessible on target but non-enumerable
    assert.equal(await target.newTab("https://example.com"), "opened:https://example.com");
    assert.equal(Object.keys(target).includes("newTab"), false);

    // ego.helpers contains SDK helpers + cliLog
    assert.equal(typeof target.ego.helpers.newTab, "function");
    assert.equal(typeof target.ego.helpers.click, "function");
    assert.equal(typeof target.ego.helpers.cliLog, "function");

    // ego.learnings is an empty namespace placeholder
    assert.deepEqual(target.ego.learnings, {});

    // ego top-level keeps only runtime built-ins
    assert.equal(typeof target.ego.sendCDPMessage, "function");
    assert.equal(typeof target.ego.createTab, "function");

    // helpers not leaked to ego top-level
    assert.equal(target.ego.newTab, undefined);
    assert.equal(target.ego.click, undefined);

    // Object.assign(ego, target) cannot copy non-enumerable helpers
    const copy = {};
    Object.assign(copy, target);
    assert.equal(copy.newTab, undefined);
    assert.equal(copy.click, undefined);

    // ego runtime methods exposed flat on target (non-enumerable)
    assert.equal(typeof target.createTab, "function");
    assert.equal(typeof target.sendCDPMessage, "function");
    assert.equal(Object.keys(target).includes("createTab"), false);
  });
});

test("browser runtime cdp rejects when sendCDPMessage throws", async () => {
  await withBrowserRuntime({
    sendCDPMessage() {
      throw new Error("boom");
    }
  }, async () => {
    await assert.rejects(() => browserCdp("Runtime.evaluate", {}, "S1", 20), /boom/);
  });
});

test("browser runtime cdp times out when no response arrives", async () => {
  const runtime = {
    onCDPMessage: undefined,
    sendCDPMessage() {}
  };
  await withBrowserRuntime(runtime, async () => {
    await assert.rejects(() => browserCdp("Runtime.evaluate", {}, "S1", 20), /timed out/);
  });
});

test("browser runtime ignores malformed and unknown CDP messages", async () => {
  const runtime = {
    onCDPMessage: undefined,
    sendCDPMessage(message) {
      this.lastMessage = JSON.parse(message);
    }
  };
  await withBrowserRuntime(runtime, async () => {
    const pending = cdp("Runtime.evaluate", { expression: "1 + 1" }, "S1");
    runtime.onCDPMessage("not json");
    runtime.onCDPMessage(JSON.stringify({ id: 999, result: { result: { value: 3 } } }));
    runtime.onCDPMessage(JSON.stringify({ method: "Network.requestWillBeSent", params: { requestId: "r1" } }));
    runtime.onCDPMessage(JSON.stringify({ id: runtime.lastMessage.id, result: { result: { value: 2 } } }));
    assert.deepEqual(await pending, { result: { value: 2 } });
    assert.deepEqual(await helpers.drainEvents(), [{ method: "Network.requestWillBeSent", params: { requestId: "r1" } }]);
  });
});

test("browser runtime surfaces CDP error responses", async () => {
  const runtime = {
    onCDPMessage: undefined,
    sendCDPMessage(message) {
      this.lastMessage = JSON.parse(message);
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: runtime.lastMessage.id, error: { message: "bad" } }));
      });
    }
  };
  await withBrowserRuntime(runtime, async () => {
    await assert.rejects(() => cdp("Runtime.evaluate", { expression: "1 + 1" }, "S1"), /bad/);
  });
});

test("browser runtime throws without ego binding", () => {
  const previous = globalThis.ego;
  delete globalThis.ego;
  try {
    assert.throws(() => browserEgo(), /browser runtime is not available/);
  } finally {
    if (previous !== undefined) {
      globalThis.ego = previous;
    }
  }
});

test("browser snapshot refs map by backendNodeId and skips invalid refs", () => {
  const refMap = new RefMap();
  browserSnapshotRefsToRefMap(refMap, [
    null,
    { backendNodeId: 7, role: "button", name: "Save" },
    "x",
    { backendNodeId: 9, role: "link", name: "Docs" },
    { role: "stale", name: "no backend id" }
  ]);

  assert.deepEqual(refMap.get("7"), {
    backendNodeId: 7,
    role: "button",
    name: "Save",
    nth: undefined,
    selector: undefined,
    frameId: undefined
  });
  assert.deepEqual(refMap.get("9"), {
    backendNodeId: 9,
    role: "link",
    name: "Docs",
    nth: undefined,
    selector: undefined,
    frameId: undefined
  });
});

test("browser runtime tab and snapshot helpers use ego APIs", async () => {
  const runtime = {
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: [{ index: 0, targetId: "tab-1", url: "https://example.com", title: "Example", active: true }] }),
    createTab: async (url) => ({ targetId: `created:${url}` }),
    snapshot: async (options) => ({
      content: `scope=${options.scope}`,
      refs: [{ backendNodeId: 42, role: "button", name: "Submit" }]
    })
  };

  await withBrowserRuntime(runtime, async () => {
    assert.equal(await helpers.newTab("https://example.com"), "created:https://example.com");
    assert.deepEqual(await helpers.currentTab(), { targetId: "tab-1", url: "https://example.com", title: "Example" });
    assert.deepEqual(await helpers.snapshot({ scope: "only_within_viewport", includeActionMarks: true, includeStableLocator: true }), {
      content: "scope=only_within_viewport",
      refs: [{ backendNodeId: 42, role: "button", name: "Submit" }]
    });
    assert.deepEqual(await helpers.snapshotRaw({ scope: "full_page" }), {
      content: "scope=full_page",
      refs: [{ backendNodeId: 42, role: "button", name: "Submit" }]
    });
  });
});
