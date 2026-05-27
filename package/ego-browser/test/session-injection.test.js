import assert from "node:assert/strict";
import test from "node:test";

import {
  browserCdp,
  ensureSession,
  invalidateSession
} from "../dist/src/browser-runtime.js";
import { state } from "../dist/src/state.js";

function mockEgo({ tabs = [{ targetId: "T1", active: true }], attachReply = "S1", onSend } = {}) {
  let lastMessage = null;
  const fake = {
    listTabs: async () => ({ tabs }),
    onCDPMessage: undefined,
    sendCDPMessage(payload) {
      lastMessage = JSON.parse(payload);
      if (onSend) {
        const reply = onSend(lastMessage);
        if (reply !== undefined) {
          queueMicrotask(() => fake.onCDPMessage(JSON.stringify(reply)));
          return;
        }
      }
      let result = {};
      if (lastMessage.method === "Target.attachToTarget") {
        result = { sessionId: attachReply };
      }
      queueMicrotask(() =>
        fake.onCDPMessage(JSON.stringify({ id: lastMessage.id, result }))
      );
    },
    get lastMessage() {
      return lastMessage;
    }
  };
  return fake;
}

function withEgo(ego, fn) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  invalidateSession();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
      invalidateSession();
    });
}

test("browser-level methods skip session injection", async () => {
  const ego = mockEgo();
  await withEgo(ego, async () => {
    await browserCdp("Target.getTargets");
    assert.equal(ego.lastMessage.method, "Target.getTargets");
    assert.equal(ego.lastMessage.sessionId, undefined);
    assert.equal(state.sessionId, null, "no session created for browser-level call");
  });
});

test("page-level methods auto-attach and inject sessionId", async () => {
  const ego = mockEgo({ attachReply: "SID-ABC" });
  await withEgo(ego, async () => {
    await browserCdp("Runtime.evaluate", { expression: "1+1" });
    assert.equal(ego.lastMessage.method, "Runtime.evaluate");
    assert.equal(ego.lastMessage.sessionId, "SID-ABC");
    assert.equal(state.sessionId, "SID-ABC");
    assert.equal(state.sessionTargetId, "T1");
  });
});

test("explicit sessionId is respected and not overridden", async () => {
  const ego = mockEgo();
  await withEgo(ego, async () => {
    await browserCdp("Runtime.evaluate", {}, "EXPLICIT-SID");
    assert.equal(ego.lastMessage.sessionId, "EXPLICIT-SID");
    assert.equal(state.sessionId, null, "no auto-attach when sessionId explicit");
  });
});

test("session cached within TTL avoids re-attach", async () => {
  let attachCalls = 0;
  const ego = mockEgo({
    onSend: (msg) => {
      if (msg.method === "Target.attachToTarget") {
        attachCalls += 1;
        return { id: msg.id, result: { sessionId: "S1" } };
      }
      return { id: msg.id, result: {} };
    }
  });
  await withEgo(ego, async () => {
    await browserCdp("Runtime.evaluate", {});
    await browserCdp("Page.navigate", { url: "x" });
    await browserCdp("Input.dispatchMouseEvent", {});
    assert.equal(attachCalls, 1, "single attach for three page-level calls in TTL window");
  });
});

test("concurrent ensureSession calls deduplicate to single attach", async () => {
  let attachCalls = 0;
  const ego = mockEgo({
    onSend: (msg) => {
      if (msg.method === "Target.attachToTarget") {
        attachCalls += 1;
        return { id: msg.id, result: { sessionId: "S1" } };
      }
      return { id: msg.id, result: {} };
    }
  });
  await withEgo(ego, async () => {
    await Promise.all([
      ensureSession(),
      ensureSession(),
      ensureSession(),
      ensureSession(),
      ensureSession()
    ]);
    assert.equal(attachCalls, 1, "inflight dedupe collapses to one attach");
  });
});

test("Session not found triggers single retry with fresh attach", async () => {
  let attachCalls = 0;
  let evalCalls = 0;
  const ego = mockEgo({
    onSend: (msg) => {
      if (msg.method === "Target.attachToTarget") {
        attachCalls += 1;
        return { id: msg.id, result: { sessionId: `S${attachCalls}` } };
      }
      if (msg.method === "Runtime.evaluate") {
        evalCalls += 1;
        if (evalCalls === 1) {
          return { id: msg.id, error: { message: "Session with given id not found" } };
        }
        return { id: msg.id, result: { result: { value: 2 } } };
      }
      return { id: msg.id, result: {} };
    }
  });
  await withEgo(ego, async () => {
    const r = await browserCdp("Runtime.evaluate", { expression: "1+1" });
    assert.equal(attachCalls, 2, "re-attached after session lost");
    assert.equal(evalCalls, 2, "retried evaluate");
    assert.equal(r.result?.result?.value, 2);
  });
});

test("invalidateSession clears cache", async () => {
  const ego = mockEgo();
  await withEgo(ego, async () => {
    await browserCdp("Runtime.evaluate", {});
    assert.ok(state.sessionId);
    invalidateSession();
    assert.equal(state.sessionId, null);
    assert.equal(state.sessionTargetId, null);
    assert.equal(state.sessionAt, 0);
  });
});

test("fallback to last tab when none is marked active", async () => {
  const ego = mockEgo({
    tabs: [
      { targetId: "TA", active: false },
      { targetId: "TB", active: false },
      { targetId: "TC", active: false }
    ]
  });
  await withEgo(ego, async () => {
    await browserCdp("Runtime.evaluate", {});
    assert.equal(state.sessionTargetId, "TC", "fell back to last tab");
  });
});

test("Target.detachedFromTarget event invalidates matching session", async () => {
  const ego = mockEgo();
  await withEgo(ego, async () => {
    await browserCdp("Runtime.evaluate", {});
    assert.equal(state.sessionTargetId, "T1");
    ego.onCDPMessage(
      JSON.stringify({ method: "Target.detachedFromTarget", params: { targetId: "T1" } })
    );
    assert.equal(state.sessionId, null, "detach event cleared cached session");
  });
});

test("no active tab surfaces a clear error", async () => {
  const ego = mockEgo({ tabs: [] });
  await withEgo(ego, async () => {
    await assert.rejects(() => browserCdp("Runtime.evaluate", {}), /no active tab/);
  });
});
