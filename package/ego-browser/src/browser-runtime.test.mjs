import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../dist/src/state.js";
import { cdp } from "../dist/src/cdp-eval.js";
import {
  CdpRequestTimeoutError,
  ProfileWideCdpClearError,
  browserCdp,
  drainBrowserEvents,
  drainPageEvents,
  ensureFrameSessions,
  ensureNetworkTracking,
  ensureSession,
  invalidateSession,
  networkActivity,
  pageNetworkSessions,
  prepareFileChooser,
  subscribeBrowserEvents,
} from "../dist/src/browser-runtime.js";

test("browserCdp exposes a typed transport timeout", async () => {
  const previous = globalThis.ego;
  globalThis.ego = { sendCDPMessage() {} };
  try {
    await assert.rejects(
      () => browserCdp("Browser.getVersion", {}, undefined, 5),
      (error) => {
        assert(error instanceof CdpRequestTimeoutError);
        assert.equal(error.code, "EGO_CDP_REQUEST_TIMEOUT");
        assert.equal(error.method, "Browser.getVersion");
        assert.equal(error.timeoutMs, 5);
        assert.match(
          error.message,
          /CDP request timed out: Browser\.getVersion/,
        );
        return true;
      },
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("frame sessions follow one Page target and are invalidated with it", async () => {
  const previous = globalThis.ego;
  const attachCounts = new Map();
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      let result = {};
      if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [
            { targetId: "page-main", type: "page" },
            {
              targetId: "frame-child",
              type: "iframe",
              parentFrameId: "same-process-frame",
            },
            {
              targetId: "frame-grandchild",
              type: "iframe",
              parentFrameId: "same-process-inside-child",
            },
            {
              targetId: "foreign-frame",
              type: "iframe",
              parentFrameId: "foreign-page",
            },
          ],
        };
      } else if (request.method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: { id: "page-main" },
            childFrames: [
              {
                frame: { id: "same-process-frame" },
                childFrames: [
                  {
                    frame: { id: "frame-child" },
                    childFrames: [
                      {
                        frame: { id: "same-process-inside-child" },
                        childFrames: [{ frame: { id: "frame-grandchild" } }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      } else if (request.method === "Target.attachToTarget") {
        const targetId = request.params.targetId;
        attachCounts.set(targetId, (attachCounts.get(targetId) || 0) + 1);
        result = { sessionId: `session:${targetId}` };
      }
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
  };
  globalThis.ego = runtime;

  try {
    const first = await ensureFrameSessions("page-main");
    assert.deepEqual(
      [...first],
      [
        ["same-process-frame", "session:page-main"],
        ["frame-child", "session:frame-child"],
        ["same-process-inside-child", "session:frame-child"],
        ["frame-grandchild", "session:frame-grandchild"],
      ],
    );
    assert.deepEqual(
      [...first.parentFrameIds],
      [
        ["same-process-frame", "page-main"],
        ["frame-child", "same-process-frame"],
        ["same-process-inside-child", "frame-child"],
        ["frame-grandchild", "same-process-inside-child"],
      ],
      "frame sessions retain the ancestry needed to render an OOPIF cursor",
    );
    assert.equal(attachCounts.has("foreign-frame"), false);

    invalidateSession("page-main");
    const second = await ensureFrameSessions("page-main");
    assert.deepEqual([...second], [...first]);
    assert.equal(attachCounts.get("frame-child"), 2);
    assert.equal(attachCounts.get("frame-grandchild"), 2);
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("network tracking is continuous and does not consume Page events", async () => {
  const previous = globalThis.ego;
  const methods = [];
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      methods.push([request.method, request.sessionId]);
      const result =
        request.method === "Target.attachToTarget"
          ? { sessionId: "session:page-main" }
          : {};
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
  };
  globalThis.ego = runtime;

  try {
    const sessionId = await ensureSession("page-main");
    assert.equal(sessionId, "session:page-main");
    assert.equal(
      methods.filter(([method]) => method === "Network.enable").length,
      1,
      "a Page session starts network tracking before it is returned",
    );

    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.requestWillBeSent",
        params: {
          requestId: "favicon-without-terminal-event",
          request: { url: "https://example.com/favicon.ico" },
        },
      }),
    );
    assert.equal(
      networkActivity([sessionId]).inflight,
      0,
      "favicon traffic must not keep a Page from reaching network idle",
    );
    assert.deepEqual(
      drainPageEvents(sessionId).map((event) => event.method),
      ["Network.requestWillBeSent"],
      "ignoring favicon activity for idle does not hide its public event",
    );

    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.requestWillBeSent",
        params: {
          requestId: "favicon-without-terminal-event",
          redirectResponse: { status: 302 },
          request: { url: "https://example.com/assets/icon.png" },
        },
      }),
    );
    assert.equal(
      networkActivity([sessionId]).inflight,
      0,
      "a redirected favicon stays excluded for its entire request chain",
    );
    assert.deepEqual(
      drainPageEvents(sessionId).map((event) => event.method),
      ["Network.requestWillBeSent"],
      "excluding a favicon redirect does not hide its public event",
    );

    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.loadingFinished",
        params: { requestId: "favicon-without-terminal-event" },
      }),
    );
    drainPageEvents(sessionId);
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.requestWillBeSent",
        params: {
          requestId: "favicon-without-terminal-event",
          request: { url: "https://example.com/api/data" },
        },
      }),
    );
    assert.equal(
      networkActivity([sessionId]).inflight,
      1,
      "a favicon request id is released when a terminal event arrives",
    );
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.loadingFinished",
        params: { requestId: "favicon-without-terminal-event" },
      }),
    );
    drainPageEvents(sessionId);

    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Runtime.consoleAPICalled",
        params: { value: "keep me" },
      }),
    );
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.requestWillBeSent",
        params: { requestId: "slow-request" },
      }),
    );

    assert.deepEqual(networkActivity([sessionId]).inflight, 1);
    await ensureNetworkTracking([sessionId]);
    assert.equal(
      methods.filter(([method]) => method === "Network.enable").length,
      1,
      "ensuring an initialized tracker is idempotent",
    );
    assert.deepEqual(
      drainPageEvents(sessionId).map((event) => event.method),
      ["Runtime.consoleAPICalled", "Network.requestWillBeSent"],
      "reading tracker state leaves the public Page event queue intact",
    );

    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.loadingFinished",
        params: { requestId: "slow-request" },
      }),
    );
    assert.equal(networkActivity([sessionId]).inflight, 0);

    await browserCdp("Network.disable", {}, sessionId);
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId,
        method: "Network.loadingFinished",
        params: { requestId: "late-after-disable" },
      }),
    );
    assert.equal(
      networkActivity([sessionId]).tracking,
      false,
      "a late event after Network.disable must not resurrect tracking",
    );
    await ensureNetworkTracking([sessionId]);
    assert.equal(
      methods.filter(([method]) => method === "Network.enable").length,
      2,
      "the next sensitive operation must restore disabled tracking",
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("Page network sessions include only its known OOPIF descendants", async () => {
  const previous = globalThis.ego;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      let result = {};
      if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [
            { targetId: "page-main", type: "page" },
            {
              targetId: "frame-child",
              type: "iframe",
              parentFrameId: "page-main",
            },
            {
              targetId: "foreign-frame",
              type: "iframe",
              parentFrameId: "foreign-page",
            },
          ],
        };
      } else if (request.method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: { id: "page-main" },
            childFrames: [{ frame: { id: "frame-child" } }],
          },
        };
      } else if (request.method === "Target.attachToTarget") {
        result = { sessionId: `session:${request.params.targetId}` };
      }
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
  };
  globalThis.ego = runtime;

  try {
    const mainSessionId = await ensureSession("page-main");
    assert.deepEqual(await pageNetworkSessions(mainSessionId), [
      "session:page-main",
      "session:frame-child",
    ]);
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a live auto-attached OOPIF survives a temporarily incomplete frame tree", async () => {
  const previous = globalThis.ego;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      let result = {};
      if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [
            { targetId: "page-main", type: "page" },
            {
              targetId: "frame-child",
              type: "iframe",
              parentFrameId: "same-process-parent",
            },
          ],
        };
      } else if (request.method === "Page.getFrameTree") {
        // Target and frame-tree snapshots are not atomic. The target can be
        // visible one protocol turn before its parent frame appears here.
        result = { frameTree: { frame: { id: "page-main" } } };
      } else if (request.method === "Target.attachToTarget") {
        result = { sessionId: `session:${request.params.targetId}` };
      }
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
  };
  globalThis.ego = runtime;

  try {
    const mainSessionId = await ensureSession("page-main");
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId: mainSessionId,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "session:frame-child",
          targetInfo: {
            targetId: "frame-child",
            type: "iframe",
            parentFrameId: "same-process-parent",
          },
          waitingForDebugger: true,
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await pageNetworkSessions(mainSessionId), [
      "session:page-main",
      "session:frame-child",
    ]);
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("Page network session discovery honors its transport timeout", async () => {
  const previous = globalThis.ego;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      if (request.method === "Target.getTargets") return;
      const result =
        request.method === "Target.attachToTarget"
          ? { sessionId: `session:${request.params.targetId}` }
          : {};
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
  };
  globalThis.ego = runtime;

  try {
    const mainSessionId = await ensureSession("page-main");
    await assert.rejects(
      () => pageNetworkSessions(mainSessionId, 10),
      (error) => {
        assert(error instanceof CdpRequestTimeoutError);
        assert.equal(error.method, "Target.getTargets");
        assert(error.timeoutMs > 0 && error.timeoutMs <= 10);
        return true;
      },
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a shorter network-tracking waiter does not cancel shared initialization", async () => {
  const previous = globalThis.ego;
  let delayedNetworkEnable;
  const methods = [];
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      methods.push([request.method, request.sessionId]);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: `session:${request.params.targetId}` };
      } else if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [
            { targetId: "page-main", type: "page" },
            {
              targetId: "frame-child",
              type: "iframe",
              parentFrameId: "page-main",
            },
          ],
        };
      } else if (request.method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: { id: "page-main" },
            childFrames: [
              { frame: { id: "frame-child", parentId: "page-main" } },
            ],
          },
        };
      }
      const respond = () => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      };
      if (
        request.method === "Network.enable" &&
        request.sessionId === "session:frame-child"
      ) {
        delayedNetworkEnable = respond;
        setTimeout(respond, 80);
        return;
      }
      queueMicrotask(respond);
    },
  };
  globalThis.ego = runtime;

  try {
    const mainSessionId = await ensureSession("page-main");
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId: mainSessionId,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "session:frame-child",
          targetInfo: {
            targetId: "frame-child",
            type: "iframe",
            parentFrameId: "page-main",
          },
          waitingForDebugger: false,
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const discoveryStartedAt = performance.now();
    assert.deepEqual(await pageNetworkSessions(mainSessionId, 10), [
      "session:page-main",
      "session:frame-child",
    ]);
    assert(
      performance.now() - discoveryStartedAt < 60,
      "best-effort initialization must stay inside discovery's budget",
    );

    const startedAt = performance.now();
    await assert.rejects(
      () => ensureNetworkTracking(["session:frame-child"], 10),
      (error) => {
        assert(error instanceof CdpRequestTimeoutError);
        assert.equal(error.method, "Network.enable");
        assert.equal(error.timeoutMs, 10);
        return true;
      },
    );
    assert(
      performance.now() - startedAt < 60,
      "the short waiter must honor its own budget",
    );
    assert.equal(typeof delayedNetworkEnable, "function");
    assert.equal(
      methods.filter(
        ([method, sessionId]) =>
          method === "Network.enable" && sessionId === "session:frame-child",
      ).length,
      1,
      "the short waiter must reuse the existing Network.enable request",
    );

    await new Promise((resolve) => setTimeout(resolve, 90));
    await ensureNetworkTracking(["session:frame-child"], 10);
    assert.equal(
      methods.filter(
        ([method, sessionId]) =>
          method === "Network.enable" && sessionId === "session:frame-child",
      ).length,
      1,
      "the shared request still completes for later callers",
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a shorter session waiter does not cancel shared auto-attach initialization", async () => {
  const previous = globalThis.ego;
  const methods = [];
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      methods.push([request.method, request.sessionId]);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: `session:${request.params.targetId}` };
      } else if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [
            { targetId: "page-main", type: "page" },
            {
              targetId: "frame-child",
              type: "iframe",
              parentFrameId: "page-main",
            },
          ],
        };
      } else if (request.method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: { id: "page-main" },
            childFrames: [
              { frame: { id: "frame-child", parentId: "page-main" } },
            ],
          },
        };
      }
      const respond = () => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      };
      if (
        request.method === "Target.setAutoAttach" &&
        request.sessionId === "session:frame-child"
      ) {
        setTimeout(respond, 80);
        return;
      }
      queueMicrotask(respond);
    },
  };
  globalThis.ego = runtime;

  try {
    const mainSessionId = await ensureSession("page-main");
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId: mainSessionId,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "session:frame-child",
          targetInfo: {
            targetId: "frame-child",
            type: "iframe",
            parentFrameId: "page-main",
          },
          waitingForDebugger: false,
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const discoveryStartedAt = performance.now();
    assert.deepEqual(await pageNetworkSessions(mainSessionId, 10), [
      "session:page-main",
      "session:frame-child",
    ]);
    assert(
      performance.now() - discoveryStartedAt < 60,
      "shared auto-attach must stay inside discovery's budget",
    );

    const startedAt = performance.now();
    assert.equal(await ensureSession("frame-child", 10), "session:frame-child");
    assert(
      performance.now() - startedAt < 60,
      "best-effort auto-attach must not outlive the session wait budget",
    );
    assert.equal(
      methods.filter(
        ([method, sessionId]) =>
          method === "Target.setAutoAttach" &&
          sessionId === "session:frame-child",
      ).length,
      1,
      "the short waiter must reuse the existing auto-attach request",
    );

    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(await ensureSession("frame-child", 10), "session:frame-child");
    assert.equal(
      methods.filter(
        ([method, sessionId]) =>
          method === "Target.setAutoAttach" &&
          sessionId === "session:frame-child",
      ).length,
      1,
      "the shared auto-attach request still completes for later callers",
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("an OOPIF document request can finish in its child session", async () => {
  const previous = globalThis.ego;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      let result = {};
      if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [
            { targetId: "page-main", type: "page" },
            {
              targetId: "frame-child",
              type: "iframe",
              parentFrameId: "page-main",
              url: "https://frame.example/",
            },
          ],
        };
      } else if (request.method === "Page.getFrameTree") {
        result = {
          frameTree: {
            frame: { id: "page-main" },
            childFrames: [{ frame: { id: "frame-child" } }],
          },
        };
      } else if (request.method === "Target.attachToTarget") {
        result = { sessionId: `session:${request.params.targetId}` };
      } else if (request.method === "Runtime.evaluate") {
        result = { result: { value: "loading" } };
      }
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
    emit(sessionId, method, params) {
      runtime.onCDPMessage(JSON.stringify({ sessionId, method, params }));
    },
  };
  globalThis.ego = runtime;

  try {
    const mainSession = await ensureSession("page-main");
    const foreignSession = await ensureSession("page-foreign");
    runtime.emit(mainSession, "Network.requestWillBeSent", {
      requestId: "document-request",
      frameId: "frame-child",
      loaderId: "document-request",
      type: "Document",
      request: { url: "https://frame.example/" },
    });
    runtime.emit(foreignSession, "Network.requestWillBeSent", {
      requestId: "document-request",
      frameId: "foreign-frame",
      loaderId: "document-request",
      type: "Document",
      request: { url: "https://foreign.example/" },
    });

    const sessions = await pageNetworkSessions(mainSession);
    runtime.emit("session:frame-child", "Network.loadingFinished", {
      requestId: "document-request",
    });

    assert.equal(networkActivity(sessions).inflight, 0);
    assert.equal(
      networkActivity([foreignSession]).inflight,
      1,
      "a terminal event must not clear an unrelated Page's request",
    );

    runtime.emit(mainSession, "Network.requestWillBeSent", {
      requestId: "reattached-document",
      frameId: "frame-child",
      loaderId: "reattached-document",
      type: "Document",
    });
    await pageNetworkSessions(mainSession);
    runtime.emit(mainSession, "Target.targetDestroyed", {
      targetId: "frame-child",
    });
    assert.equal(
      networkActivity([mainSession]).tracking,
      true,
      "destroying an OOPIF must not detach its parent Page session",
    );
    assert.equal(
      networkActivity([mainSession]).inflight,
      0,
      "destroying a reattached OOPIF removes its migrated document request",
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("auto-attached OOPIFs are instrumented and resumed without waiting for Network.enable", async () => {
  const previous = globalThis.ego;
  const sent = [];
  let delayedChildNetworkEnable;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      if (
        request.method === "Network.enable" &&
        request.sessionId === "session:frame-child"
      ) {
        delayedChildNetworkEnable = request;
        return;
      }
      queueMicrotask(() => {
        if (
          request.method === "Target.setAutoAttach" &&
          request.sessionId === "session:page-main"
        ) {
          runtime.onCDPMessage(
            JSON.stringify({
              sessionId: "session:page-main",
              method: "Network.requestWillBeSent",
              params: {
                requestId: "oopif-document",
                frameId: "frame-child",
                loaderId: "oopif-document",
                type: "Document",
              },
            }),
          );
          runtime.onCDPMessage(
            JSON.stringify({
              sessionId: "session:page-main",
              method: "Target.attachedToTarget",
              params: {
                sessionId: "session:frame-child",
                targetInfo: {
                  targetId: "frame-child",
                  type: "iframe",
                  parentFrameId: "same-process-parent",
                },
                waitingForDebugger: true,
              },
            }),
          );
        }
        const result =
          request.method === "Target.attachToTarget"
            ? { sessionId: `session:${request.params.targetId}` }
            : {};
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
        if (
          request.method === "Runtime.runIfWaitingForDebugger" &&
          request.sessionId === "session:frame-child" &&
          delayedChildNetworkEnable
        ) {
          runtime.onCDPMessage(
            JSON.stringify({ id: delayedChildNetworkEnable.id, result: {} }),
          );
          delayedChildNetworkEnable = undefined;
        }
      });
    },
  };
  globalThis.ego = runtime;

  try {
    await ensureSession("page-main");
    await new Promise((resolve) => setImmediate(resolve));

    const mainAutoAttach = sent.find(
      (request) =>
        request.method === "Target.setAutoAttach" &&
        request.sessionId === "session:page-main",
    );
    assert.equal(mainAutoAttach?.params?.autoAttach, true);
    assert.equal(mainAutoAttach?.params?.waitForDebuggerOnStart, true);
    assert.equal(mainAutoAttach?.params?.flatten, true);

    const childNetworkIndex = sent.findIndex(
      (request) =>
        request.method === "Network.enable" &&
        request.sessionId === "session:frame-child",
    );
    const childResumeIndex = sent.findIndex(
      (request) =>
        request.method === "Runtime.runIfWaitingForDebugger" &&
        request.sessionId === "session:frame-child",
    );
    assert.ok(childNetworkIndex >= 0, "the child Network domain is enabled");
    assert.ok(childResumeIndex >= 0, "the paused child is resumed");
    assert.ok(
      childNetworkIndex < childResumeIndex,
      "Network.enable is sent before the child resumes",
    );
    assert.equal(
      delayedChildNetworkEnable,
      undefined,
      "resuming does not await the Network.enable response",
    );
    assert.equal(
      networkActivity(["session:page-main", "session:frame-child"]).inflight,
      1,
      "enabling the child Network domain preserves the migrated request",
    );
    runtime.onCDPMessage(
      JSON.stringify({
        sessionId: "session:frame-child",
        method: "Network.loadingFinished",
        params: { requestId: "oopif-document" },
      }),
    );
    assert.equal(
      networkActivity(["session:page-main", "session:frame-child"]).inflight,
      0,
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("dedicated workers are auto-attached and resumed immediately", async () => {
  const previous = globalThis.ego;
  const sent = [];
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      sent.push(request);
      const result =
        request.method === "Target.attachToTarget"
          ? { sessionId: "session:page-main" }
          : {};
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
  };
  globalThis.ego = runtime;

  try {
    const mainSessionId = await ensureSession("page-main");
    const autoAttach = sent.find(
      (request) =>
        request.method === "Target.setAutoAttach" &&
        request.sessionId === mainSessionId,
    );
    assert.deepEqual(autoAttach?.params?.filter, [
      { type: "iframe", exclude: false },
      { type: "worker", exclude: false },
      { exclude: true },
    ]);

    runtime.onCDPMessage(
      JSON.stringify({
        sessionId: mainSessionId,
        method: "Target.attachedToTarget",
        params: {
          sessionId: "session:worker-child",
          targetInfo: {
            targetId: "worker-child",
            type: "worker",
            parentId: "page-main",
          },
          waitingForDebugger: true,
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      sent.some(
        (request) =>
          request.method === "Runtime.runIfWaitingForDebugger" &&
          request.sessionId === "session:worker-child",
      ),
      "a worker paused by auto-attach must be resumed",
    );
    assert.equal(
      sent.some(
        (request) =>
          request.method === "Network.enable" &&
          request.sessionId === "session:worker-child",
      ),
      false,
      "resuming a worker must not opt it into Page network tracking",
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

// Gap A: ensureSession() calls the raw listTabs binding to attach a session.
// When the task is blocked it returns { error, error_code }; the result must
// surface the ego-browser-owned wording for the code (not the native error
// message) and carry error_code, instead of throwing the bare native error message.
test("browserCdp surfaces the owned message and error_code when ensureSession is blocked", async () => {
  globalThis.ego = {
    async listTabs() {
      return {
        error: "Task space 10 is not assigned to an agent.",
        error_code: "EGO_TASK_SPACE_INACTIVE",
      };
    },
  };
  try {
    await assert.rejects(
      () => browserCdp("Runtime.evaluate", {}, undefined, 1000),
      (err) => {
        assert.equal(err.error_code, "EGO_TASK_SPACE_INACTIVE");
        // Owned guidance block, not the native "Task space 10 ..." text.
        assert.match(err.message, /claimTaskSpace\(spaceId\)/);
        assert.doesNotMatch(err.message, /\b10\b/);
        return true;
      },
    );
  } finally {
    delete globalThis.ego;
  }
});

// Gap B: a raw CDP send that fails locally is reported through
// ego.onSendCDPMessageError, not as a CDP response. Without wiring the request
// would hang until the 15s timeout; wired, it rejects immediately with the
// owned message and error_code.
test("browserCdp rejects the in-flight request via onSendCDPMessageError", async () => {
  globalThis.ego = {
    sendCDPMessage() {
      // The binding delivers the failure asynchronously through the event loop.
      queueMicrotask(() =>
        globalThis.ego.onSendCDPMessageError(
          "native reconstructed text",
          "EGO_TASK_SPACE_INACTIVE",
        ),
      );
    },
  };
  try {
    await assert.rejects(
      // Browser-level method skips ensureSession; short timeout bounds a regression.
      () => browserCdp("Browser.getVersion", {}, undefined, 1000),
      (err) => {
        assert.equal(err.error_code, "EGO_TASK_SPACE_INACTIVE");
        // Owned guidance block, not the native reconstructed text.
        assert.match(err.message, /claimTaskSpace\(spaceId\)/);
        assert.doesNotMatch(err.message, /native reconstructed text/);
        return true;
      },
    );
  } finally {
    delete globalThis.ego;
  }
});

test("a non-user-control CDP failure does not run the permission probe", async () => {
  const previous = globalThis.ego;
  let probes = 0;
  const runtime = {
    async setAgentTaskState() {
      probes += 1;
      return undefined;
    },
    sendCDPMessage() {
      queueMicrotask(() => {
        runtime.onSendCDPMessageError(
          "The task space is inactive.",
          "EGO_TASK_SPACE_INACTIVE",
        );
      });
    },
  };
  globalThis.ego = runtime;

  try {
    await assert.rejects(
      () => browserCdp("Browser.getVersion", {}, undefined, 1000),
      (error) => {
        assert.equal(error.error_code, "EGO_TASK_SPACE_INACTIVE");
        assert.match(error.message, /no longer assigned to the agent/);
        return true;
      },
    );
    assert.equal(probes, 0);
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a user-control CDP failure probes the native permission reason before rejecting", async () => {
  const previous = globalThis.ego;
  let probes = 0;
  const runtime = {
    async setAgentTaskState() {
      probes += 1;
      return {
        error: "microphone",
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      };
    },
    sendCDPMessage() {
      queueMicrotask(() => {
        runtime.onSendCDPMessageError(
          "The task is under user control.",
          "EGO_TASK_SPACE_USER_IN_CONTROL",
        );
      });
    },
  };
  globalThis.ego = runtime;

  try {
    await assert.rejects(
      () => browserCdp("Browser.getVersion", {}, undefined, 1000),
      (error) => {
        assert.equal(error.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
        assert.match(error.message, /microphone access/);
        return true;
      },
    );
    assert.equal(probes, 1);
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("concurrent user-control CDP failures share one permission probe", async () => {
  const previous = globalThis.ego;
  let probes = 0;
  let finishProbe;
  const runtime = {
    setAgentTaskState() {
      probes += 1;
      return new Promise((resolve) => {
        finishProbe = resolve;
      });
    },
    sendCDPMessage() {
      queueMicrotask(() => {
        runtime.onSendCDPMessageError(
          "The task is under user control.",
          "EGO_TASK_SPACE_USER_IN_CONTROL",
        );
      });
    },
  };
  globalThis.ego = runtime;

  try {
    const requests = [
      browserCdp("Browser.getVersion", {}, undefined, 1000),
      browserCdp("Browser.getBrowserCommandLine", {}, undefined, 1000),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 1);
    finishProbe({
      error: "camera",
      error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
    });
    const results = await Promise.allSettled(requests);
    assert.deepEqual(
      results.map((result) => result.status),
      ["rejected", "rejected"],
    );
    for (const result of results) {
      assert.match(result.reason.message, /camera access/);
    }
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a failed permission probe falls back to generic user-control guidance", async () => {
  const previous = globalThis.ego;
  const runtime = {
    async setAgentTaskState() {
      throw new Error("probe transport failed");
    },
    sendCDPMessage() {
      queueMicrotask(() => {
        runtime.onSendCDPMessageError(
          "The task is under user control.",
          "EGO_TASK_SPACE_USER_IN_CONTROL",
        );
      });
    },
  };
  globalThis.ego = runtime;

  try {
    await assert.rejects(
      () => browserCdp("Browser.getVersion", {}, undefined, 1000),
      (error) => {
        assert.match(error.message, /The user has taken control/);
        assert.doesNotMatch(error.message, /probe transport failed/);
        return true;
      },
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a recovered probe allows a later takeover to be detected", async () => {
  const previous = globalThis.ego;
  let probes = 0;
  const runtime = {
    async setAgentTaskState() {
      probes += 1;
      if (probes === 1) return undefined;
      return {
        error: "location",
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      };
    },
    sendCDPMessage() {
      queueMicrotask(() => {
        runtime.onSendCDPMessageError(
          "The task is under user control.",
          "EGO_TASK_SPACE_USER_IN_CONTROL",
        );
      });
    },
  };
  globalThis.ego = runtime;

  try {
    await assert.rejects(
      () => browserCdp("Browser.getVersion", {}, undefined, 1000),
      /The task is under user control/,
    );
    await assert.rejects(
      () => browserCdp("Browser.getVersion", {}, undefined, 1000),
      /location access/,
    );
    assert.equal(probes, 2);
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("CDP events are drained only by the target session that received them", async () => {
  const previous = globalThis.ego;
  let nextSession = 1;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      const result =
        request.method === "Target.attachToTarget"
          ? { sessionId: `session-${nextSession++}` }
          : {};
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
    emit(sessionId, method, params = {}) {
      runtime.onCDPMessage(JSON.stringify({ sessionId, method, params }));
    },
  };
  globalThis.ego = runtime;

  try {
    const attachedA = await browserCdp("Target.attachToTarget", {
      targetId: "target-a",
      flatten: true,
    });
    const attachedB = await browserCdp("Target.attachToTarget", {
      targetId: "target-b",
      flatten: true,
    });
    const sessionA = attachedA.result.sessionId;
    const sessionB = attachedB.result.sessionId;

    runtime.emit(sessionA, "Network.requestWillBeSent", {
      requestId: "request-a",
    });

    assert.deepEqual(
      drainBrowserEvents(sessionB),
      [],
      "target B must not consume target A events",
    );
    assert.deepEqual(
      drainBrowserEvents(sessionA).map((event) => event.params.requestId),
      ["request-a"],
      "target A retains its own event queue",
    );
  } finally {
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
});

test("a JavaScript dialog interrupts the blocked Page input command", async () => {
  const previous = globalThis.ego;
  let sessionId;
  let pendingDisableRequestId;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      if (request.method === "Target.attachToTarget") {
        sessionId = "session-dialog";
        queueMicrotask(() => {
          runtime.onCDPMessage(
            JSON.stringify({ id: request.id, result: { sessionId } }),
          );
        });
        return;
      }
      if (request.method === "Page.enable") {
        queueMicrotask(() => {
          runtime.onCDPMessage(JSON.stringify({ id: request.id, result: {} }));
        });
        return;
      }
      if (request.method === "Page.setInterceptFileChooserDialog") {
        if (request.params.enabled) {
          queueMicrotask(() => {
            runtime.onCDPMessage(
              JSON.stringify({ id: request.id, result: {} }),
            );
          });
        } else {
          pendingDisableRequestId = request.id;
        }
        return;
      }
      if (request.method === "Input.dispatchMouseEvent") {
        // Chromium keeps this request pending until the modal dialog closes.
        queueMicrotask(() => {
          runtime.onCDPMessage(
            JSON.stringify({
              sessionId,
              method: "Page.javascriptDialogOpening",
              params: {
                type: "alert",
                message: "Confirm action",
                url: "https://example.test/dialog",
              },
            }),
          );
        });
      }
    },
  };
  globalThis.ego = runtime;

  try {
    const attached = await browserCdp("Target.attachToTarget", {
      targetId: "target-dialog",
      flatten: true,
    });
    await browserCdp("Page.enable", {}, attached.result.sessionId);
    const fileChooser = prepareFileChooser(attached.result.sessionId, {
      timeoutMs: 1_000,
      cancel: true,
    });
    await fileChooser.ready;

    await assert.rejects(
      () =>
        browserCdp(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", x: 10, y: 10 },
          attached.result.sessionId,
          100,
        ),
      (error) => {
        assert.equal(error.code, "EGO_PAGE_DIALOG_OPENED");
        assert.deepEqual(error.dialog, {
          type: "alert",
          message: "Confirm action",
          url: "https://example.test/dialog",
        });
        return true;
      },
    );

    await assert.rejects(
      () =>
        browserCdp(
          "Runtime.releaseObject",
          { objectId: "element-1" },
          attached.result.sessionId,
          100,
        ),
      (error) => {
        assert.equal(error.code, "EGO_PAGE_DIALOG_OPENED");
        assert.equal(error.method, "Runtime.releaseObject");
        return true;
      },
    );

    const disposeStartedAt = Date.now();
    setTimeout(() => {
      runtime.onCDPMessage?.(
        JSON.stringify({ id: pendingDisableRequestId, result: {} }),
      );
    }, 60);
    await fileChooser.dispose();
    assert(
      Date.now() - disposeStartedAt < 40,
      "dialog handling must not wait for file chooser cleanup",
    );
  } finally {
    invalidateSession();
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
});

test("page event drains exclude unscoped browser events", async () => {
  const previous = globalThis.ego;
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      const result =
        request.method === "Target.attachToTarget"
          ? { sessionId: "session-page" }
          : {};
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
    emit(event) {
      runtime.onCDPMessage(JSON.stringify(event));
    },
  };
  globalThis.ego = runtime;

  try {
    const attached = await browserCdp("Target.attachToTarget", {
      targetId: "target-page",
      flatten: true,
    });
    const sessionId = attached.result.sessionId;
    runtime.emit({ method: "Target.targetCreated", params: { targetId: "x" } });
    runtime.emit({
      sessionId,
      method: "Runtime.consoleAPICalled",
      params: { value: "page" },
    });

    assert.deepEqual(
      drainPageEvents(sessionId).map((event) => event.method),
      ["Runtime.consoleAPICalled"],
    );
    assert.deepEqual(
      drainBrowserEvents(sessionId).map((event) => event.method),
      ["Target.targetCreated"],
      "legacy drain still exposes unscoped browser events",
    );
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("browser event subscribers are isolated and can unsubscribe", async () => {
  const previous = globalThis.ego;
  const originalConsoleError = console.error;
  const received = [];
  const reported = [];
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result: {} }));
      });
    },
    emit(event) {
      runtime.onCDPMessage(JSON.stringify(event));
    },
  };
  globalThis.ego = runtime;
  console.error = (...args) => reported.push(args);

  const unsubscribeThrowing = subscribeBrowserEvents(() => {
    throw new Error("subscriber failed");
  });
  const unsubscribe = subscribeBrowserEvents((event) => received.push(event));
  try {
    await browserCdp("Target.setDiscoverTargets", { discover: true });
    runtime.emit({
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "popup-1", type: "page" } },
    });
    unsubscribe();
    runtime.emit({
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "popup-2", type: "page" } },
    });

    assert.deepEqual(
      received.map((event) => event.params.targetInfo.targetId),
      ["popup-1"],
    );
    assert.equal(reported.length, 2, "each throwing callback is contained");
  } finally {
    unsubscribe();
    unsubscribeThrowing();
    console.error = originalConsoleError;
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a native CDP callback contains internal handler failures", async () => {
  const previous = globalThis.ego;
  const originalConsoleError = console.error;
  const reported = [];
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      const result =
        request.method === "Target.attachToTarget"
          ? { sessionId: "session-callback-guard" }
          : {};
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
  };
  globalThis.ego = runtime;
  console.error = (...args) => reported.push(args);
  let interception;

  try {
    const attached = await browserCdp("Target.attachToTarget", {
      targetId: "target-callback-guard",
      flatten: true,
    });
    const sessionId = attached.result.sessionId;
    interception = prepareFileChooser(sessionId, {
      timeoutMs: 1_000,
      cancel: false,
    });
    await interception.ready;
    interception.resolve = () => {
      throw new Error("file chooser handler failed");
    };

    assert.doesNotThrow(() => {
      runtime.onCDPMessage(
        JSON.stringify({
          sessionId,
          method: "Page.fileChooserOpened",
          params: { backendNodeId: 42, mode: "selectSingle" },
        }),
      );
    });
    assert.equal(reported.length, 1);
    assert.match(String(reported[0][0]), /onCDPMessage/);

    const response = await browserCdp(
      "Runtime.evaluate",
      { expression: "1" },
      sessionId,
      1_000,
    );
    assert.deepEqual(response.result, {});
  } finally {
    console.error = originalConsoleError;
    await interception?.dispose();
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("runtime callbacks can be released without deleting a foreign replacement", async () => {
  const previous = globalThis.ego;
  const runtimeModule = await import("../dist/src/browser-runtime.js");
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      queueMicrotask(() => {
        runtime.onCDPMessage(
          JSON.stringify({ id: request.id, result: { ok: true } }),
        );
      });
    },
  };
  globalThis.ego = runtime;

  try {
    assert.equal(
      typeof runtimeModule.releaseRuntimeCallbacks,
      "function",
      "the SDK lifecycle needs an explicit callback release hook",
    );
    await browserCdp("Target.getTargets", {}, undefined, 1_000);
    assert.equal(typeof runtime.onCDPMessage, "function");
    assert.equal(typeof runtime.onSendCDPMessageError, "function");

    runtimeModule.releaseRuntimeCallbacks(runtime);
    assert.equal(runtime.onCDPMessage, undefined);
    assert.equal(runtime.onSendCDPMessageError, undefined);

    await browserCdp("Target.getTargets", {}, undefined, 1_000);
    const foreignMessage = () => {};
    const foreignError = () => {};
    runtime.onCDPMessage = foreignMessage;
    runtime.onSendCDPMessageError = foreignError;
    runtimeModule.releaseRuntimeCallbacks(runtime);
    assert.equal(runtime.onCDPMessage, foreignMessage);
    assert.equal(runtime.onSendCDPMessageError, foreignError);
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("file chooser interception suppresses the native picker and returns its input", async () => {
  const previous = globalThis.ego;
  const calls = [];
  const runtime = {
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      calls.push(request);
      const result =
        request.method === "Target.attachToTarget"
          ? { sessionId: "session-upload" }
          : {};
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
    emit(event) {
      runtime.onCDPMessage(JSON.stringify(event));
    },
  };
  globalThis.ego = runtime;

  try {
    const attached = await browserCdp("Target.attachToTarget", {
      targetId: "target-upload",
      flatten: true,
    });
    const sessionId = attached.result.sessionId;
    const interception = prepareFileChooser(sessionId, {
      timeoutMs: 1_000,
      cancel: true,
    });
    await interception.ready;

    runtime.emit({
      sessionId,
      method: "Page.fileChooserOpened",
      params: {
        backendNodeId: 42,
        frameId: "frame-upload",
        mode: "selectMultiple",
      },
    });
    assert.equal((await interception.event).backendNodeId, 42);
    await interception.dispose();

    assert(
      calls.some(
        (call) =>
          call.method === "Page.setInterceptFileChooserDialog" &&
          call.params.enabled === true,
      ),
    );
    assert(
      calls.some(
        (call) =>
          call.method === "DOM.setFileInputFiles" &&
          call.params.backendNodeId === 42 &&
          call.params.files.length === 0,
      ),
      "the safety interceptor cancels the chooser with an empty file list",
    );
    assert(
      calls.some(
        (call) =>
          call.method === "Page.setInterceptFileChooserDialog" &&
          call.params.enabled === false,
      ),
    );
  } finally {
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("a profile-wide CDP clear is refused before it reaches the browser", async () => {
  // Real agent runs reached for these while reasoning about a single site; each
  // call wiped the cookies and cache of every task space sharing the profile,
  // along with the user's own tabs in it.
  const attempted = [];
  const restore = setOverrides({
    cdpOverride: async (method) => {
      attempted.push(method);
      return {};
    },
  });
  try {
    for (const method of [
      "Network.clearBrowserCookies",
      "Network.clearBrowserCache",
      "Storage.clearCookies",
    ]) {
      await assert.rejects(
        () => browserCdp(method, {}),
        (error) => {
          assert(error instanceof ProfileWideCdpClearError);
          assert.equal(error.code, "EGO_CDP_PROFILE_WIDE_CLEAR");
          assert.equal(error.method, method);
          return true;
        },
        `${method} must be refused`,
      );
    }
    assert.deepEqual(attempted, [], "no refused clear reaches the transport");
  } finally {
    restore();
  }
});

test("the refusal names a scoped command to run instead", async () => {
  await assert.rejects(
    () => browserCdp("Network.clearBrowserCookies", {}),
    (error) => {
      assert.match(error.message, /Storage\.clearDataForOrigin/);
      assert.match(error.message, /storageTypes: "cookies"/);
      return true;
    },
  );
  await assert.rejects(
    () => browserCdp("Network.clearBrowserCache", {}),
    (error) => {
      assert.match(error.message, /Page\.reload.*ignoreCache: true/);
      return true;
    },
  );
});

test("the bare cdp() helper is guarded like page.cdp and task.cdp", async () => {
  // Every entry point funnels into browserCdp, so the bare helper — the one most
  // of the observed calls used — is covered by the same guard.
  await assert.rejects(
    () => cdp("Network.clearBrowserCookies"),
    (error) => {
      assert.equal(error.code, "EGO_CDP_PROFILE_WIDE_CLEAR");
      return true;
    },
  );
});

test("a scoped clear still reaches the browser", async () => {
  const attempted = [];
  const restore = setOverrides({
    cdpOverride: async (method) => {
      attempted.push(method);
      return {};
    },
  });
  try {
    await browserCdp("Network.deleteCookies", {
      name: "session",
      url: "https://example.com/",
    });
    await browserCdp("Storage.clearDataForOrigin", {
      origin: "https://example.com",
      storageTypes: "cookies",
    });
    await browserCdp("Storage.clearCookies", { browserContextId: "ctx-1" });
    assert.deepEqual(attempted, [
      "Network.deleteCookies",
      "Storage.clearDataForOrigin",
      "Storage.clearCookies",
    ]);
  } finally {
    restore();
  }
});
