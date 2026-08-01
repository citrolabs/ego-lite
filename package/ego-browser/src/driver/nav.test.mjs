import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import {
  browserCdp,
  invalidateSession,
  pendingDialog,
} from "../../dist/src/browser-runtime.js";
import {
  listTabs,
  newTab,
  openOrReuseTab,
  pageInfo,
  setViewportSize,
  closeTab,
  switchTab,
} from "../../dist/src/driver/nav.js";
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
          {
            targetId: "target-1",
            active: true,
            title: "Example",
            url: "https://example.com/",
          },
        ],
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
              ph: 1200,
            }),
          },
        };
      }
      queueMicrotask(() =>
        runtime.onCDPMessage(JSON.stringify({ id: request.id, result })),
      );
    },
    emit(method, params) {
      runtime.onCDPMessage(
        JSON.stringify({ sessionId: "session-1", method, params }),
      );
    },
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
  await withEgo(
    {
      async listTabs() {
        return { error: "The task is under user control" };
      },
    },
    async () => {
      await assert.rejects(
        () => listTabs(),
        /listTabs: The task is under user control/,
      );
    },
  );
});

test("newTab throws on ego binding error objects", async () => {
  await withEgo(
    {
      async createTab() {
        return { error: "The task is under user control" };
      },
    },
    async () => {
      await assert.rejects(
        () => newTab("https://example.com/"),
        /newTab: The task is under user control/,
      );
    },
  );
});

test("newTab throws when the binding returns no targetId", async () => {
  await withEgo(
    {
      async createTab() {
        return {};
      },
    },
    async () => {
      await assert.rejects(
        () => newTab("https://example.com/"),
        /newTab returned no targetId/,
      );
    },
  );
});

test("openOrReuseTab settles a newly opened tab in milliseconds, not seconds", async () => {
  // Regression: the new-tab branch used to sleep(settle * 1000), so settle:500
  // (documented as 500ms) blocked for 500 seconds while the reuse branch
  // already treated it as milliseconds.
  const sleeps = [];
  await withEgo(
    {
      async listTabs() {
        return { tabs: [] }; // no match → open a new tab
      },
      async createTab() {
        return { targetId: "target-new" };
      },
    },
    async () => {
      const restore = setOverrides({
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });
      try {
        const opened = await openOrReuseTab("https://example.com/fresh", {
          wait: false,
          settle: 500,
        });
        assert.equal(opened.reused, false);
        assert.equal(opened.targetId, "target-new");
      } finally {
        restore();
      }
    },
  );

  assert.deepEqual(sleeps, [500]);
});

test("switchTab refreshes the target list before activating it", async () => {
  const calls = [];
  await withEgo(
    {
      async listTabs() {
        return {
          tabs: [
            {
              targetId: "target-1",
              active: true,
              title: "Home",
              url: "https://example.com/",
            },
            {
              targetId: "target-2",
              active: false,
              title: "Docs",
              url: "https://example.com/docs",
            },
          ],
        };
      },
    },
    async () => {
      const restore = setOverrides({
        cdpOverride(method, params, sessionId) {
          calls.push({ method, params, sessionId });
          return { success: true };
        },
      });
      try {
        assert.equal(await switchTab({ targetId: "target-2" }), "target-2");
      } finally {
        restore();
      }
    },
  );

  assert.deepEqual(calls, [
    {
      method: "Target.activateTarget",
      params: { targetId: "target-2" },
      sessionId: undefined,
    },
  ]);
});

test("switchTab rejects a stale target with the refreshed tab list", async () => {
  let cdpCalled = false;
  await withEgo(
    {
      async listTabs() {
        return {
          tabs: [
            {
              targetId: "target-current",
              active: true,
              title: "Current",
              url: "https://example.com/current",
            },
          ],
        };
      },
    },
    async () => {
      const restore = setOverrides({
        cdpOverride() {
          cdpCalled = true;
          return {};
        },
      });
      try {
        await assert.rejects(
          () => switchTab("target-stale"),
          (error) => {
            assert.match(error.message, /switchTab target not found/);
            assert.match(error.message, /target-stale/);
            assert.match(error.message, /target-current/);
            assert.match(error.message, /https:\/\/example\.com\/current/);
            return true;
          },
        );
      } finally {
        restore();
      }
    },
  );
  assert.equal(cdpCalled, false);
});

test("switchTab rejects tab objects without targetId at the boundary", async () => {
  await assert.rejects(
    () => switchTab({ id: "target-2" }),
    /switchTab requires a targetId.*received.*id/,
  );
});

test("closeTab closes an explicit current target and returns its id", async () => {
  const calls = [];
  await withEgo(
    {
      async listTabs() {
        return {
          tabs: [
            {
              targetId: "target-2",
              active: true,
              title: "Example",
              url: "https://example.com/",
            },
          ],
        };
      },
    },
    async () => {
      const restore = setOverrides({
        cdpOverride(method, params, sessionId) {
          calls.push({ method, params, sessionId });
          return { success: true };
        },
      });
      try {
        assert.equal(await closeTab("target-2"), "target-2");
      } finally {
        restore();
      }
    },
  );

  assert.deepEqual(calls, [
    {
      method: "Target.closeTarget",
      params: { targetId: "target-2" },
      sessionId: undefined,
    },
  ]);
});

test("closeTab rejects a stale explicit target before CDP dispatch", async () => {
  let cdpCalled = false;
  await withEgo(
    {
      async listTabs() {
        return {
          tabs: [
            {
              targetId: "target-current",
              active: true,
              title: "Current",
              url: "https://example.com/current",
            },
          ],
        };
      },
    },
    async () => {
      const restore = setOverrides({
        cdpOverride() {
          cdpCalled = true;
          return {};
        },
      });
      try {
        await assert.rejects(
          () => closeTab("target-stale"),
          /closeTab target not found.*target-stale.*target-current/,
        );
      } finally {
        restore();
      }
    },
  );
  assert.equal(cdpCalled, false);
});

test("closeTab waits for a closed target to disappear from listTabs", async () => {
  let listCount = 0;
  let now = 0;
  const sleeps = [];
  await withEgo(
    {
      async listTabs() {
        listCount += 1;
        const scratchStillListed = listCount < 3;
        return {
          tabs: [
            {
              targetId: "target-current",
              active: !scratchStillListed,
              title: "Current",
              url: "https://example.com/current",
            },
            ...(scratchStillListed
              ? [
                  {
                    targetId: "target-scratch",
                    active: true,
                    title: "Scratch",
                    url: "https://example.com/scratch",
                  },
                ]
              : []),
          ],
        };
      },
    },
    async () => {
      const restore = setOverrides({
        cdpOverride: async () => ({ success: true }),
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      });
      try {
        assert.equal(await closeTab("target-scratch"), "target-scratch");
        assert.deepEqual(sleeps, [50]);
      } finally {
        restore();
      }
    },
  );
});

test("closeTab closes the current tab and invalidates matching session state", async () => {
  const calls = [];
  await withEgo(
    {
      async listTabs() {
        return {
          tabs: [
            {
              targetId: "target-1",
              active: true,
              title: "Example",
              url: "https://example.com/",
            },
          ],
        };
      },
    },
    async () => {
      const restore = setOverrides({
        cdpOverride(method, params, sessionId) {
          calls.push({ method, params, sessionId });
          return { success: true };
        },
        sessionId: "session-1",
        sessionTargetId: "target-1",
        sessionAt: Date.now(),
        preferredTargetId: "target-1",
      });
      try {
        assert.equal(await closeTab(), "target-1");
        assert.equal(state.sessionId, null);
        assert.equal(state.sessionTargetId, null);
        assert.equal(state.preferredTargetId, null);
      } finally {
        restore();
      }
    },
  );

  assert.deepEqual(calls, [
    {
      method: "Target.closeTarget",
      params: { targetId: "target-1" },
      sessionId: undefined,
    },
  ]);
});

test("browser runtime enables Page events and tracks pending native dialogs", async () => {
  await withCdpRuntime(async ({ runtime, sent }) => {
    await browserCdp("Runtime.evaluate", { expression: "document.title" });

    assert.deepEqual(
      sent.map((request) => request.method),
      ["Target.attachToTarget", "Page.enable", "Runtime.evaluate"],
    );
    assert.equal(sent[1].sessionId, "session-1");

    runtime.emit("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Confirm action",
      url: "https://example.com/",
    });
    assert.deepEqual(pendingDialog(), {
      type: "alert",
      message: "Confirm action",
      url: "https://example.com/",
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
      url: "https://example.com/",
    });

    assert.deepEqual(await pageInfo(), {
      dialog: {
        type: "confirm",
        message: "Leave page?",
        url: "https://example.com/",
      },
    });
    assert.equal(
      sent.some((request) => request.method === "Runtime.evaluate"),
      false,
    );
  });
});

test("pageInfo tolerates a transient document without documentElement", async () => {
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      assert.equal(method, "Runtime.evaluate");
      const value = runInNewContext(params.expression, {
        document: {
          documentElement: null,
          title: "Loading",
        },
        innerHeight: 600,
        innerWidth: 800,
        location: { href: "https://example.com/loading" },
        scrollX: 0,
        scrollY: 0,
      });
      return { result: { value } };
    },
  });
  try {
    assert.deepEqual(await pageInfo(), {
      url: "https://example.com/loading",
      title: "Loading",
      w: 800,
      h: 600,
      sx: 0,
      sy: 0,
      pw: 800,
      ph: 600,
    });
  } finally {
    restore();
  }
});

test("setViewportSize accepts an exact unscaled CSS viewport", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({ width: 390, height: 844, dpr: 1 }),
          },
        };
      }
      return {};
    },
  });
  try {
    await setViewportSize({ width: 390, height: 844 });
  } finally {
    restore();
  }

  assert.deepEqual(
    calls.filter(
      ({ method }) => method === "Emulation.setDeviceMetricsOverride",
    ),
    [
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          width: 390,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        },
      },
    ],
  );
});

test("setViewportSize compensates for a scaled CSS viewport", async () => {
  const metricCalls = [];
  const observations = [
    { width: 312, height: 675, dpr: 1.25 },
    { width: 390, height: 844, dpr: 1.25 },
  ];
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") {
        metricCalls.push(params);
        return {};
      }
      if (method === "Runtime.evaluate") {
        return {
          result: { value: JSON.stringify(observations.shift()) },
        };
      }
      return {};
    },
  });
  try {
    await setViewportSize({ width: 390, height: 844 });
  } finally {
    restore();
  }

  assert.deepEqual(metricCalls, [
    {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    },
    {
      width: 488,
      height: 1055,
      deviceScaleFactor: 1,
      mobile: false,
    },
  ]);
});

test("setViewportSize rejects invalid dimensions before CDP dispatch", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (...args) => {
      calls.push(args);
      return {};
    },
  });
  try {
    for (const viewport of [
      { width: 0, height: 844 },
      { width: 390, height: -1 },
      { width: Number.NaN, height: 844 },
      { width: 390, height: Number.POSITIVE_INFINITY },
      { width: 390.5, height: 844 },
    ]) {
      await assert.rejects(
        () => setViewportSize(viewport),
        /positive integer width and height/,
      );
    }
  } finally {
    restore();
  }
  assert.deepEqual(calls, []);
});

test("setViewportSize reports a persistent viewport mismatch", async () => {
  const restore = setOverrides({
    cdpOverride: async (method) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: JSON.stringify({ width: 312, height: 675, dpr: 1.25 }),
          },
        };
      }
      return {};
    },
  });
  try {
    await assert.rejects(
      () => setViewportSize({ width: 390, height: 844 }),
      /requested 390x844 CSS pixels.*observed 312x675.*devicePixelRatio 1\.25/,
    );
  } finally {
    restore();
  }
});
