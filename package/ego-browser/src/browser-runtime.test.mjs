import test from "node:test";
import assert from "node:assert/strict";

import {
  browserCdp,
  drainBrowserEvents,
  invalidateSession,
  isBrowserRuntime,
  pendingDialog,
  setPreferredTarget,
  clearPreferredTarget,
  ensureSession,
  browserSnapshotRefsToRefMap,
  waitForBrowserEvent,
} from "../dist/src/browser-runtime.js";
import { state } from "../dist/src/state.js";

/**
 * Install a mock ego that auto-responds to every CDP send with { result: {} }.
 * Use the returned `calls` array to inspect what was sent, and `ego.onCDPMessage`
 * (set by rawCdp after the first send) to deliver events directly.
 */
function installAutoEgo(listTabsResult) {
  const calls = [];
  const tabs = listTabsResult || {
    tabs: [{ targetId: "tab-1", active: true }],
  };
  globalThis.ego = {
    async listTabs() {
      return tabs;
    },
    sendCDPMessage(payload) {
      const parsed = JSON.parse(payload);
      calls.push(parsed);
      setTimeout(() => {
        if (globalThis.ego?.onCDPMessage) {
          const result =
            parsed.method === "Target.attachToTarget"
              ? { sessionId: `auto-sess-${parsed.id}` }
              : {};
          globalThis.ego.onCDPMessage(
            JSON.stringify({ id: parsed.id, result }),
          );
        }
      }, 0);
    },
  };
  return calls;
}

/**
 * Install a mock ego with manual control over sendCDPMessage.
 * Returns the calls array; use ego.onCDPMessage after a send to deliver responses.
 */
function installManualEgo(listTabsResult) {
  const calls = [];
  const tabs = listTabsResult || {
    tabs: [{ targetId: "tab-1", active: true }],
  };
  globalThis.ego = {
    async listTabs() {
      return tabs;
    },
    sendCDPMessage(payload) {
      calls.push(JSON.parse(payload));
    },
  };
  return calls;
}

/** Fire a CDP event through the handler set up by rawCdp. */
function fireEvent(method, params = {}, sessionId) {
  const msg = { method, params };
  if (sessionId) msg.sessionId = sessionId;
  globalThis.ego.onCDPMessage(JSON.stringify(msg));
}

function cleanup() {
  delete globalThis.ego;
  invalidateSession();
  clearPreferredTarget();
  drainBrowserEvents();
  state.cdpOverride = null;
  state.sessionInflight = null;
}

/* ------------------------------------------------------------------ */
/*  isBrowserRuntime                                                  */
/* ------------------------------------------------------------------ */

test("isBrowserRuntime returns false when ego is not installed", () => {
  delete globalThis.ego;
  assert.equal(isBrowserRuntime(), false);
});

test("isBrowserRuntime returns true when ego has sendCDPMessage", () => {
  installAutoEgo();
  try {
    assert.equal(isBrowserRuntime(), true);
  } finally {
    cleanup();
  }
});

test("isBrowserRuntime returns false when ego lacks sendCDPMessage", () => {
  globalThis.ego = { listTabs() {} };
  try {
    assert.equal(isBrowserRuntime(), false);
  } finally {
    delete globalThis.ego;
  }
});

/* ------------------------------------------------------------------ */
/*  rawCdp — request/response                                         */
/* ------------------------------------------------------------------ */

test("browserCdp with explicit sessionId sends and resolves on matching response", async () => {
  const calls = installManualEgo();
  try {
    const promise = browserCdp(
      "Runtime.evaluate",
      { expression: "1" },
      "sess-1",
      5000,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "Runtime.evaluate");
    assert.equal(calls[0].sessionId, "sess-1");
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: { value: 42 } }),
    );
    const result = await promise;
    assert.deepEqual(result.result, { value: 42 });
  } finally {
    cleanup();
  }
});

test("browserCdp rejects when CDP response carries an error", async () => {
  const calls = installManualEgo();
  try {
    const promise = browserCdp("Runtime.evaluate", {}, "sess-1", 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, error: { message: "SyntaxError" } }),
    );
    await assert.rejects(promise, /SyntaxError/);
  } finally {
    cleanup();
  }
});

test("browserCdp times out when no response arrives", async () => {
  installManualEgo();
  try {
    await assert.rejects(
      () => browserCdp("Runtime.evaluate", {}, "sess-1", 100),
      /CDP request timed out: Runtime\.evaluate/,
    );
  } finally {
    cleanup();
  }
});

test("browserCdp rejects when sendCDPMessage throws synchronously", async () => {
  globalThis.ego = {
    sendCDPMessage() {
      throw new Error("binding gone");
    },
  };
  try {
    await assert.rejects(
      () => browserCdp("Target.getVersion", {}, undefined, 1000),
      /binding gone/,
    );
  } finally {
    cleanup();
  }
});

test("handleMessage ignores unparseable JSON", async () => {
  const calls = installManualEgo();
  try {
    // Trigger rawCdp to set up onCDPMessage
    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage("not valid json{{{");
    const evts = drainBrowserEvents();
    assert.equal(evts.length, 0, "bad JSON is silently ignored");
    // Clean up: respond to the pending request
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;
  } finally {
    cleanup();
  }
});

test("handleMessage ignores responses for unknown request ids", async () => {
  const calls = installManualEgo();
  try {
    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(JSON.stringify({ id: 999999, result: {} }));
    const evts = drainBrowserEvents();
    assert.equal(evts.length, 0, "unknown id produces no events");
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  drainBrowserEvents — event buffer                                 */
/* ------------------------------------------------------------------ */

test("drainBrowserEvents collects CDP events and clears the buffer", async () => {
  const calls = installManualEgo();
  try {
    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    fireEvent("Network.requestWillBeSent", { requestId: "1" });
    fireEvent("Page.loadEventFired", { timestamp: 123 });

    const first = drainBrowserEvents();
    assert.equal(first.length, 2);
    assert.equal(first[0].method, "Network.requestWillBeSent");
    assert.equal(first[1].method, "Page.loadEventFired");

    const second = drainBrowserEvents();
    assert.equal(second.length, 0, "second drain returns empty");
  } finally {
    cleanup();
  }
});

test("subscribeBrowserEvent delivers events from the requested session", async () => {
  const runtime = await import("../dist/src/browser-runtime.js");
  assert.equal(typeof runtime.subscribeBrowserEvent, "function");

  installAutoEgo();
  let unsubscribe;
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const received = [];
    unsubscribe = runtime.subscribeBrowserEvent(
      "Page.screencastFrame",
      "sess-video",
      (event) => received.push(event.params.data),
    );

    fireEvent("Page.screencastFrame", { data: "wrong" }, "sess-other");
    fireEvent("Page.screencastFrame", { data: "frame-1" }, "sess-video");

    assert.deepEqual(received, ["frame-1"]);
  } finally {
    unsubscribe?.();
    cleanup();
  }
});

test("subscribeBrowserEvent stops delivery after unsubscribe", async () => {
  const { subscribeBrowserEvent } =
    await import("../dist/src/browser-runtime.js");
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const received = [];
    const unsubscribe = subscribeBrowserEvent(
      "Page.screencastFrame",
      "sess-video",
      (event) => received.push(event.params.data),
    );
    unsubscribe();

    fireEvent("Page.screencastFrame", { data: "late-frame" }, "sess-video");

    assert.deepEqual(received, []);
  } finally {
    cleanup();
  }
});

test("subscribeBrowserEvent isolates listener failures", async () => {
  const { subscribeBrowserEvent } =
    await import("../dist/src/browser-runtime.js");
  installAutoEgo();
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  let unsubscribeFailing;
  let unsubscribeHealthy;
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    unsubscribeFailing = subscribeBrowserEvent(
      "Page.screencastFrame",
      "sess-video",
      () => {
        throw new Error("subscriber failed");
      },
    );
    const received = [];
    unsubscribeHealthy = subscribeBrowserEvent(
      "Page.screencastFrame",
      "sess-video",
      (event) => received.push(event.params.data),
    );

    assert.doesNotThrow(() => {
      fireEvent("Page.screencastFrame", { data: "frame-1" }, "sess-video");
    });

    assert.deepEqual(received, ["frame-1"]);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /subscriber/i);
    assert.match(String(errors[0][1]), /subscriber failed/);
  } finally {
    unsubscribeFailing?.();
    unsubscribeHealthy?.();
    console.error = originalConsoleError;
    cleanup();
  }
});

test("subscribed screencast frames bypass the generic event buffer", async () => {
  const { subscribeBrowserEvent } =
    await import("../dist/src/browser-runtime.js");
  installAutoEgo();
  let unsubscribe;
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    unsubscribe = subscribeBrowserEvent(
      "Page.screencastFrame",
      "sess-video",
      () => {},
    );

    fireEvent(
      "Page.screencastFrame",
      { data: "large-base64-frame" },
      "sess-video",
    );

    assert.deepEqual(drainBrowserEvents(), []);
  } finally {
    unsubscribe?.();
    cleanup();
  }
});

test("waitForBrowserEvent resolves future matching events", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    const promise = waitForBrowserEvent(
      (event) => event.method === "Page.downloadWillBegin",
      500,
    );
    fireEvent("Page.downloadWillBegin", {
      guid: "download-1",
      suggestedFilename: "file.png",
    });
    const event = await promise;
    assert.equal(event.params.guid, "download-1");
  } finally {
    cleanup();
  }
});

test("waitForBrowserEvent ignores events that happened before waiting", async () => {
  installAutoEgo();
  try {
    await browserCdp("Runtime.evaluate", { expression: "1" });
    fireEvent("Page.downloadWillBegin", {
      guid: "old-download",
      suggestedFilename: "old.png",
    });
    const promise = waitForBrowserEvent(
      (event) => event.method === "Page.downloadWillBegin",
      500,
    );
    fireEvent("Page.downloadWillBegin", {
      guid: "new-download",
      suggestedFilename: "new.png",
    });
    const event = await promise;
    assert.equal(event.params.guid, "new-download");
  } finally {
    cleanup();
  }
});

test("drainBrowserEvents caps at MAX_BUFFERED_EVENTS (10000)", async () => {
  const calls = installManualEgo();
  try {
    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    for (let i = 0; i < 10005; i++) {
      fireEvent(`evt.${i}`, {});
    }
    const evts = drainBrowserEvents();
    assert.equal(evts.length, 10000, "buffer capped at 10000 events");
    assert.equal(evts[0].method, "evt.5", "oldest events dropped");
    assert.equal(evts[evts.length - 1].method, "evt.10004");
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  Dialog tracking                                                   */
/* ------------------------------------------------------------------ */

test("pendingDialog tracks dialog open and close", async () => {
  const calls = installManualEgo();
  try {
    state.sessionId = "sess-d";
    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    assert.equal(pendingDialog(), null, "no dialog initially");

    fireEvent(
      "Page.javascriptDialogOpening",
      { type: "alert", message: "Hello" },
      "sess-d",
    );
    const dialog = pendingDialog();
    assert.ok(dialog, "dialog is pending after opening event");
    assert.equal(dialog.type, "alert");
    assert.equal(dialog.message, "Hello");

    fireEvent("Page.javascriptDialogClosed", {}, "sess-d");
    assert.equal(pendingDialog(), null, "dialog cleared after close event");
  } finally {
    cleanup();
  }
});

test("pendingDialog uses state.sessionId when event has no sessionId", async () => {
  const calls = installManualEgo();
  try {
    state.sessionId = "sess-fallback";
    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    fireEvent("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Sure?",
    });
    const dialog = pendingDialog("sess-fallback");
    assert.ok(dialog, "dialog tracked via state.sessionId fallback");
    assert.equal(dialog.type, "confirm");
  } finally {
    cleanup();
  }
});

test("pendingDialog returns null for a different session", async () => {
  const calls = installManualEgo();
  try {
    state.sessionId = "sess-a";
    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    fireEvent("Page.javascriptDialogOpening", { type: "alert" }, "sess-b");
    assert.equal(pendingDialog("sess-a"), null, "no dialog on sess-a");
    assert.ok(pendingDialog("sess-b"), "dialog exists on sess-b");
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  Target detach — invalidates session and cleans up dialog state    */
/* ------------------------------------------------------------------ */

test("Target.detachedFromTarget invalidates session when targetId matches", async () => {
  const calls = installManualEgo();
  try {
    state.sessionId = "sess-detach";
    state.sessionTargetId = "target-1";
    state.sessionAt = Date.now();

    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    fireEvent("Page.javascriptDialogOpening", { type: "alert" }, "sess-detach");
    assert.ok(pendingDialog("sess-detach"), "dialog present before detach");

    fireEvent("Target.detachedFromTarget", {
      targetId: "target-1",
      sessionId: "sess-detach",
    });

    assert.equal(state.sessionId, null, "session invalidated after detach");
    assert.equal(state.sessionTargetId, null);
    assert.equal(
      pendingDialog("sess-detach"),
      null,
      "dialog cleaned up on detach",
    );
  } finally {
    cleanup();
  }
});

test("Target.targetDestroyed also invalidates session", async () => {
  const calls = installManualEgo();
  try {
    state.sessionId = "sess-destroy";
    state.sessionTargetId = "target-x";
    state.sessionAt = Date.now();

    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    fireEvent("Target.targetDestroyed", { targetId: "target-x" });
    assert.equal(
      state.sessionId,
      null,
      "session invalidated on target destroyed",
    );
  } finally {
    cleanup();
  }
});

test("Target.detachedFromTarget does not invalidate session for a different target", async () => {
  const calls = installManualEgo();
  try {
    state.sessionId = "sess-keep";
    state.sessionTargetId = "target-ours";
    state.sessionAt = Date.now();

    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    fireEvent("Target.detachedFromTarget", {
      targetId: "target-other",
      sessionId: "sess-other",
    });
    assert.equal(
      state.sessionId,
      "sess-keep",
      "session not invalidated for different target",
    );
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  invalidateSession                                                 */
/* ------------------------------------------------------------------ */

test("invalidateSession clears session state and dialog tracking", async () => {
  const calls = installManualEgo();
  try {
    state.sessionId = "sess-inv";
    state.sessionTargetId = "target-1";
    state.sessionAt = Date.now();

    const p = browserCdp("Target.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, result: {} }),
    );
    await p;

    fireEvent("Page.javascriptDialogOpening", { type: "alert" }, "sess-inv");
    invalidateSession();
    assert.equal(state.sessionId, null);
    assert.equal(state.sessionTargetId, null);
    assert.equal(state.sessionAt, 0);
    assert.equal(
      pendingDialog("sess-inv"),
      null,
      "dialog cleared by invalidation",
    );
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  setPreferredTarget / clearPreferredTarget                         */
/* ------------------------------------------------------------------ */

test("setPreferredTarget and clearPreferredTarget manage state", () => {
  setPreferredTarget("target-42");
  assert.equal(state.preferredTargetId, "target-42");
  clearPreferredTarget();
  assert.equal(state.preferredTargetId, null);
});

test("setPreferredTarget treats empty string as null", () => {
  setPreferredTarget("");
  assert.equal(state.preferredTargetId, null);
  setPreferredTarget(undefined);
  assert.equal(state.preferredTargetId, null);
});

/* ------------------------------------------------------------------ */
/*  ensureSession — session caching, TTL, tab selection               */
/* ------------------------------------------------------------------ */

test("ensureSession returns cached session within TTL", async () => {
  installAutoEgo();
  try {
    state.sessionId = "cached-session";
    state.sessionAt = Date.now();
    const result = await ensureSession();
    assert.equal(result, "cached-session");
  } finally {
    cleanup();
  }
});

test("ensureSession re-attaches when TTL has expired", async () => {
  installAutoEgo();
  try {
    state.sessionId = "old-session";
    state.sessionAt = Date.now() - 3000; // expired (> 2000ms TTL)
    const result = await ensureSession();
    assert.equal(typeof result, "string", "returns a session id string");
    assert.ok(result.length > 0, "session id is non-empty");
  } finally {
    cleanup();
  }
});

test("ensureSession deduplicates concurrent calls via sessionInflight", async () => {
  installAutoEgo();
  try {
    const p1 = ensureSession();
    const p2 = ensureSession();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, r2, "both callers get the same session id");
  } finally {
    cleanup();
  }
});

test("ensureSession selects the preferred tab when available", async () => {
  const calls = installAutoEgo({
    tabs: [
      { targetId: "tab-bg", active: false },
      { targetId: "tab-preferred", active: false },
      { targetId: "tab-active", active: true },
    ],
  });
  try {
    setPreferredTarget("tab-preferred");
    await ensureSession();
    const attach = calls.find((c) => c.method === "Target.attachToTarget");
    assert.ok(attach, "Target.attachToTarget was called");
    assert.equal(
      attach.params.targetId,
      "tab-preferred",
      "attaches to preferred tab",
    );
    const pageEnable = calls.find((c) => c.method === "Page.enable");
    assert.ok(pageEnable, "Page.enable was called for the attached session");
    assert.equal(pageEnable.sessionId, `auto-sess-${attach.id}`);
  } finally {
    cleanup();
  }
});

test("ensureSession falls back to the last tab when no active tab is found", async () => {
  const calls = installAutoEgo({
    tabs: [
      { targetId: "tab-1", active: false },
      { targetId: "tab-last", active: false },
    ],
  });
  try {
    await ensureSession();
    const attach = calls.find((c) => c.method === "Target.attachToTarget");
    assert.ok(attach, "Target.attachToTarget was called");
    assert.equal(attach.params.targetId, "tab-last", "falls back to last tab");
  } finally {
    cleanup();
  }
});

test("ensureSession throws when no tabs are available", async () => {
  installAutoEgo({ tabs: [] });
  try {
    await assert.rejects(() => ensureSession(), /no active tab/);
  } finally {
    cleanup();
  }
});

test("ensureSession skips re-attach when targetId matches existing session", async () => {
  const calls = installAutoEgo();
  try {
    state.sessionId = "existing";
    state.sessionTargetId = "tab-1"; // matches the default tab
    state.sessionAt = Date.now() - 3000; // force re-entry past TTL

    await ensureSession();
    const attach = calls.find((c) => c.method === "Target.attachToTarget");
    assert.equal(attach, undefined, "skips re-attach when target unchanged");
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  SESSION_LOST retry                                                */
/* ------------------------------------------------------------------ */

test("browserCdp does NOT retry SESSION_LOST for explicit sessionId", async () => {
  const calls = installManualEgo();
  try {
    const promise = browserCdp("Runtime.evaluate", {}, "explicit-sess", 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({
        id: calls[0].id,
        error: { message: "Session not found" },
      }),
    );
    await assert.rejects(promise, /Session not found/);
  } finally {
    cleanup();
  }
});

test("browserCdp does NOT retry SESSION_LOST for browser-level methods", async () => {
  const calls = installManualEgo();
  try {
    const promise = browserCdp("Browser.getVersion", {}, undefined, 5000);
    globalThis.ego.onCDPMessage(
      JSON.stringify({ id: calls[0].id, error: { message: "Target closed" } }),
    );
    await assert.rejects(promise, /Target closed/);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  handleSendError — rejects all pending on local send failure       */
/* ------------------------------------------------------------------ */

test("handleSendError rejects all pending requests with ego error", async () => {
  installManualEgo();
  try {
    const p1 = browserCdp("Target.getVersion", {}, undefined, 5000);
    const p2 = browserCdp("Browser.getVersion", {}, undefined, 5000);

    globalThis.ego.onSendCDPMessageError(
      "native text",
      "EGO_TASK_SPACE_USER_IN_CONTROL",
    );

    await assert.rejects(p1, (err) => {
      assert.equal(err.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
      return true;
    });
    await assert.rejects(p2, (err) => {
      assert.equal(err.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
      return true;
    });
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ */
/*  browserSnapshotRefsToRefMap                                       */
/* ------------------------------------------------------------------ */

test("browserSnapshotRefsToRefMap populates ref map from snapshot refs", () => {
  const refMap = {
    _data: new Map(),
    clear() {
      this._data.clear();
    },
    add(id, backendNodeId, role, name) {
      this._data.set(id, { backendNodeId, role, name });
    },
  };
  browserSnapshotRefsToRefMap(refMap, [
    { backendNodeId: 42, role: "button", name: "Submit" },
    { backendNodeId: 100, role: "link", name: "Home" },
  ]);
  assert.equal(refMap._data.size, 2);
  assert.equal(refMap._data.get("42").role, "button");
  assert.equal(refMap._data.get("100").name, "Home");
});

test("browserSnapshotRefsToRefMap clears the map before populating", () => {
  const refMap = {
    _data: new Map([["old", { backendNodeId: 1 }]]),
    clear() {
      this._data.clear();
    },
    add(id, backendNodeId, role, name) {
      this._data.set(id, { backendNodeId, role, name });
    },
  };
  browserSnapshotRefsToRefMap(refMap, [
    { backendNodeId: 5, role: "textbox", name: "" },
  ]);
  assert.equal(refMap._data.size, 1);
  assert.equal(refMap._data.has("old"), false, "old entries cleared");
});

test("browserSnapshotRefsToRefMap skips null, non-object, and missing backendNodeId refs", () => {
  const refMap = {
    _data: new Map(),
    clear() {
      this._data.clear();
    },
    add(id, backendNodeId, role, name) {
      this._data.set(id, { backendNodeId, role, name });
    },
  };
  browserSnapshotRefsToRefMap(refMap, [
    null,
    "not an object",
    { role: "button" },
    { backendNodeId: null, role: "button" },
    { backendNodeId: undefined, role: "button" },
    { backendNodeId: 7, role: "link", name: "ok" },
  ]);
  assert.equal(refMap._data.size, 1, "only the valid ref is added");
  assert.ok(refMap._data.has("7"));
});
