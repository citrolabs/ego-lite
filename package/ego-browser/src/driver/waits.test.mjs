import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { cdp } from "../../dist/src/cdp-eval.js";
import {
  drainPageEvents,
  ensureSession,
  invalidateSession,
} from "../../dist/src/browser-runtime.js";
import { waitForNetworkIdle } from "../../dist/src/driver/waits.js";

test("waitForNetworkIdle enables the Network domain and disables it afterwards", async () => {
  // Regression: nothing used to enable the Network domain, so the helper could
  // report "idle" without ever being able to observe traffic.
  const methods = [];
  let t = 0;
  const restore = setOverrides({
    cdpOverride: async (method) => {
      methods.push(method);
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  try {
    const result = await waitForNetworkIdle({ timeout: 5 });
    assert.equal(result, true, "no traffic for idleMs resolves true");
  } finally {
    restore();
  }
  assert.equal(
    methods[0],
    "Network.enable",
    "must enable Network before observing",
  );
  assert.equal(
    methods.at(-1),
    "Network.disable",
    "must disable Network when done",
  );
});

test("waitForNetworkIdle leaves a caller-enabled Network domain enabled", async () => {
  const methods = [];
  let t = 0;
  const restore = setOverrides({
    cdpOverride: async (method) => {
      methods.push(method);
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  try {
    await cdp("Network.enable"); // the caller owns the domain
    methods.length = 0;
    const result = await waitForNetworkIdle({ timeout: 5 });
    assert.equal(result, true);
  } finally {
    restore();
  }
  assert.ok(
    !methods.includes("Network.disable"),
    "must not tear down a Network domain the caller enabled",
  );
});

test("waitForNetworkIdle survives a bridge that rejects Network.enable", async () => {
  let t = 0;
  const restore = setOverrides({
    cdpOverride: async (method) => {
      if (method === "Network.enable" || method === "Network.disable") {
        throw new Error("'Network.enable' wasn't found");
      }
      return {};
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  try {
    const result = await waitForNetworkIdle({ timeout: 5 });
    assert.equal(result, true, "falls back to passive observation");
  } finally {
    restore();
  }
});

test("browser waitForNetworkIdle preserves events and observes requests already in flight", async () => {
  const previous = globalThis.ego;
  const methods = [];
  let now = 0;
  let finished = false;
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "page-main",
            active: true,
            title: "Main",
            url: "https://example.com/",
          },
        ],
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      methods.push(request.method);
      let result = {};
      if (request.method === "Target.attachToTarget") {
        result = { sessionId: `session:${request.params.targetId}` };
      } else if (request.method === "Target.getTargets") {
        result = { targetInfos: [{ targetId: "page-main", type: "page" }] };
      } else if (request.method === "Page.getFrameTree") {
        result = { frameTree: { frame: { id: "page-main" } } };
      }
      queueMicrotask(() => {
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result }));
      });
    },
    emit(method, params) {
      runtime.onCDPMessage(
        JSON.stringify({
          sessionId: "session:page-main",
          method,
          params,
        }),
      );
    },
  };
  globalThis.ego = runtime;
  const restore = setOverrides({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      if (!finished && now >= 100) {
        finished = true;
        runtime.emit("Network.loadingFinished", { requestId: "slow" });
      }
    },
  });

  try {
    const sessionId = await ensureSession("page-main");
    runtime.emit("Network.requestWillBeSent", {
      requestId: "slow",
      request: { url: "https://example.com/slow" },
    });

    assert.equal(await waitForNetworkIdle({ timeout: 1, idleMs: 200 }), true);
    assert.ok(
      now >= 300,
      "the pre-existing request must delay the idle window",
    );
    assert.deepEqual(
      drainPageEvents(sessionId).map((event) => event.method),
      ["Network.requestWillBeSent", "Network.loadingFinished"],
      "waiting must not consume the public event queue",
    );
    assert.equal(methods.includes("Network.disable"), false);
  } finally {
    restore();
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});

test("browser waitForNetworkIdle does not hide a user-control hard stop", async () => {
  const previous = globalThis.ego;
  let failTargetRefresh = false;
  const runtime = {
    async listTabs() {
      return {
        tabs: [
          {
            targetId: "page-main",
            active: true,
            title: "Main",
            url: "https://example.com/",
          },
        ],
      };
    },
    async setAgentTaskState() {
      return {
        error: "camera",
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      };
    },
    sendCDPMessage(payload) {
      const request = JSON.parse(payload);
      if (request.method === "Target.getTargets" && failTargetRefresh) {
        queueMicrotask(() => {
          runtime.onSendCDPMessageError(
            "The task is under user control.",
            "EGO_TASK_SPACE_USER_IN_CONTROL",
          );
        });
        return;
      }
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
    await ensureSession("page-main");
    failTargetRefresh = true;
    await assert.rejects(
      () => waitForNetworkIdle({ timeout: 1, idleMs: 10 }),
      (error) => {
        assert.equal(error.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
        assert.match(error.message, /camera access/);
        return true;
      },
    );
  } finally {
    invalidateSession();
    if (previous === undefined) delete globalThis.ego;
    else globalThis.ego = previous;
  }
});
