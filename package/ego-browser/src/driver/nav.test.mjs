import test from "node:test";
import assert from "node:assert/strict";

import { browserCdp, invalidateSession, pendingDialog } from "../../dist/src/browser-runtime.js";
import { listTabs, newTab, pageInfo, closeTab } from "../../dist/src/driver/nav.js";
import { setOverrides, state } from "../../dist/src/state.js";

function withEgo(ego, fn) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
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

function withCdpRuntime(fn) {
  const previous = globalThis.ego;
  const sent = [];
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          { targetId: "target-1", active: true, title: "Example", url: "https://example.com/" }
        ]
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Runtime.evaluate") {
        result = {
          result: {
            value: JSON.stringify({
              url: "https://example.com/",
              title: "Example",
              w: 800,
              h: 600,
              sx: 0,
              sy: 0,
              pw: 800,
              ph: 1200
            })
          }
        };
      }
      queueMicrotask(() => runtime.onCDPMessage(JSON.stringify({ id: request.id, result })));
    },
    emit(method, params) {
      runtime.onCDPMessage(JSON.stringify({ sessionId: "session-1", method, params }));
    }
  };
  globalThis.ego = runtime;
  invalidateSession();
  return Promise.resolve()
    .then(() => fn({ runtime, sent }))
    .finally(() => {
      invalidateSession();
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("listTabs throws on ego binding error objects", async () => {
  await withEgo({
    async listTabs() {
      return { error: "The task is under user control" };
    }
  }, async () => {
    await assert.rejects(
      () => listTabs(),
      /listTabs: The task is under user control/
    );
  });
});

test("newTab throws on ego binding error objects", async () => {
  await withEgo({
    async createTab() {
      return { error: "The task is under user control" };
    }
  }, async () => {
    await assert.rejects(
      () => newTab("https://example.com/"),
      /newTab: The task is under user control/
    );
  });
});

test("newTab throws when the binding returns no targetId", async () => {
  await withEgo({
    async createTab() {
      return {};
    }
  }, async () => {
    await assert.rejects(
      () => newTab("https://example.com/"),
      /newTab returned no targetId/
    );
  });
});

test("closeTab closes an explicit target and returns its id", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return { success: true };
    }
  });
  try {
    assert.equal(await closeTab("target-2"), "target-2");
  } finally {
    restore();
  }

  assert.deepEqual(calls, [
    {
      method: "Target.closeTarget",
      params: { targetId: "target-2" },
      sessionId: undefined
    }
  ]);
});

test("closeTab closes the current tab and invalidates matching session state", async () => {
  const calls = [];
  await withEgo({
    async listTabs() {
      return {
        tabs: [
          { targetId: "target-1", active: true, title: "Example", url: "https://example.com/" }
        ]
      };
    }
  }, async () => {
    const restore = setOverrides({
      cdpOverride(method, params, sessionId) {
        calls.push({ method, params, sessionId });
        return { success: true };
      },
      sessionId: "session-1",
      sessionTargetId: "target-1",
      sessionAt: Date.now(),
      preferredTargetId: "target-1"
    });
    try {
      assert.equal(await closeTab(), "target-1");
      assert.equal(state.sessionId, null);
      assert.equal(state.sessionTargetId, null);
      assert.equal(state.preferredTargetId, null);
    } finally {
      restore();
    }
  });

  assert.deepEqual(calls, [
    {
      method: "Target.closeTarget",
      params: { targetId: "target-1" },
      sessionId: undefined
    }
  ]);
});

test("browser runtime enables Page events and tracks pending native dialogs", async () => {
  await withCdpRuntime(async ({ runtime, sent }) => {
    await browserCdp("Runtime.evaluate", { expression: "document.title" });

    assert.deepEqual(sent.map((request) => request.method), [
      "Target.attachToTarget",
      "Page.enable",
      "Runtime.evaluate"
    ]);
    assert.equal(sent[1].sessionId, "session-1");

    runtime.emit("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Confirm action",
      url: "https://example.com/"
    });
    assert.deepEqual(pendingDialog(), {
      type: "alert",
      message: "Confirm action",
      url: "https://example.com/"
    });

    runtime.emit("Page.javascriptDialogClosed", { result: true });
    assert.equal(pendingDialog(), null);
  });
});

test("pageInfo returns pending dialog without evaluating frozen page JavaScript", async () => {
  await withCdpRuntime(async ({ runtime, sent }) => {
    await browserCdp("Runtime.evaluate", { expression: "document.title" });
    sent.length = 0;

    runtime.emit("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Leave page?",
      url: "https://example.com/"
    });

    assert.deepEqual(await pageInfo(), {
      dialog: {
        type: "confirm",
        message: "Leave page?",
        url: "https://example.com/"
      }
    });
    assert.equal(sent.some((request) => request.method === "Runtime.evaluate"), false);
  });
});
