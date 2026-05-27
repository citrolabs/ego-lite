import assert from "node:assert/strict";
import test from "node:test";

import * as helpers from "../dist/src/helpers.js";

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

function withOverrides(overrides, fn) {
  const restore = helpers.__testing.setOverrides(overrides);
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

const sampleTabs = [
  { index: 0, targetId: "t-chrome", url: "chrome://settings", title: "Settings", active: false },
  { index: 1, targetId: "t-page", url: "https://example.com", title: "Example", active: true },
  { index: 2, targetId: "t-blank", url: "about:blank", title: "", active: false }
];

test("listTabs filters internal targets when includeChrome is false", async () => {
  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: sampleTabs })
  }, async () => {
    const all = await helpers.listTabs();
    assert.deepEqual(all.map((tab) => tab.targetId), ["t-chrome", "t-page", "t-blank"]);

    const real = await helpers.listTabs({ includeChrome: false });
    assert.deepEqual(real.map((tab) => tab.targetId), ["t-page"]);
  });
});

test("currentTab returns active tab and throws on empty list", async () => {
  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: sampleTabs })
  }, async () => {
    assert.deepEqual(await helpers.currentTab(), {
      targetId: "t-page",
      url: "https://example.com",
      title: "Example"
    });
  });

  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: [] })
  }, async () => {
    await assert.rejects(() => helpers.currentTab(), /no active browser tab/);
  });
});

test("switchTab accepts target id or tab-like object and calls Target.activateTarget", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      return {};
    }
  }, async () => {
    assert.equal(await helpers.switchTab("t-page"), "t-page");
    assert.equal(await helpers.switchTab({ targetId: "t-blank" }), "t-blank");
  });
  assert.deepEqual(calls, [
    ["Target.activateTarget", { targetId: "t-page" }],
    ["Target.activateTarget", { targetId: "t-blank" }]
  ]);
});

test("newTab calls createTab and returns the new target id", async () => {
  const created = [];
  await withBrowserRuntime({
    sendCDPMessage() {},
    createTab: async (url) => {
      created.push(url);
      return { targetId: `tab:${url}` };
    }
  }, async () => {
    assert.equal(await helpers.newTab("https://example.com"), "tab:https://example.com");
    assert.equal(await helpers.newTab(), "tab:about:blank");
  });
  assert.deepEqual(created, ["https://example.com", "about:blank"]);
});

test("openOrReuseTab switches to a matching existing tab", async () => {
  const cdpCalls = [];
  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: sampleTabs })
  }, async () => {
    await withOverrides({
      cdpOverride: async (method, params) => {
        cdpCalls.push([method, params]);
        return {};
      }
    }, async () => {
      const tab = await helpers.openOrReuseTab("https://example.com/", { match: "origin+path", wait: false });
      assert.equal(tab.targetId, "t-page");
      assert.equal(tab.reused, true);
      assert.equal(tab.active, true);
    });
  });
  assert.deepEqual(cdpCalls, [["Target.activateTarget", { targetId: "t-page" }]]);
});

test("openOrReuseTab opens a new tab and waits by default", async () => {
  const created = [];
  const cdpCalls = [];
  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: [] }),
    createTab: async (url) => {
      created.push(url);
      return { targetId: "new-tab" };
    }
  }, async () => {
    await withOverrides({
      cdpOverride: async (method, params) => {
        cdpCalls.push([method, params]);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { url: "https://openai.com" } } };
        if (method === "Runtime.evaluate") return { result: { value: "complete" } };
        return {};
      }
    }, async () => {
      const tab = await helpers.openOrReuseTab("https://openai.com", { timeout: 1 });
      assert.deepEqual(tab, {
        targetId: "new-tab",
        url: "https://openai.com",
        title: "",
        active: true,
        reused: false
      });
    });
  });
  assert.deepEqual(created, ["https://openai.com"]);
  assert.equal(cdpCalls.some(([method]) => method === "Page.getFrameTree"), true);
  assert.equal(cdpCalls.some(([method]) => method === "Runtime.evaluate"), true);
});

test("gotoAndWait navigates, waits for load, and settles", async () => {
  const calls = [];
  await withOverrides({
    sleep: async (ms) => calls.push(["sleep", ms]),
    now: (() => {
      let now = 0;
      return () => {
        now += 100;
        return now;
      };
    })(),
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "Page.navigate") return { frameId: "frame-1" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { url: "https://example.com" } } };
      if (method === "Runtime.evaluate") return { result: { value: "complete" } };
      return {};
    }
  }, async () => {
    const result = await helpers.gotoAndWait("https://example.com", { timeout: 1, settle: 0.25 });
    assert.deepEqual(result, { navigation: { frameId: "frame-1" }, loaded: true });
  });
  assert.deepEqual(calls.at(0), ["Page.navigate", { url: "https://example.com" }]);
  assert.deepEqual(calls.at(-1), ["sleep", 250]);
});

test("ensureRealTab keeps current page when not internal", async () => {
  const calls = [];
  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: sampleTabs })
  }, async () => {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        return {};
      }
    }, async () => {
      const result = await helpers.ensureRealTab();
      assert.deepEqual(result, { targetId: "t-page", url: "https://example.com", title: "Example" });
    });
  });
  assert.equal(calls.length, 0);
});

test("ensureRealTab switches to first non-internal tab when current is chrome://", async () => {
  const tabs = [
    { index: 0, targetId: "t-chrome", url: "chrome://newtab", title: "New", active: true },
    { index: 1, targetId: "t-real", url: "https://example.com", title: "Example", active: false }
  ];
  const calls = [];
  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs })
  }, async () => {
    await withOverrides({
      cdpOverride: async (method, params) => {
        calls.push([method, params]);
        return {};
      }
    }, async () => {
      const result = await helpers.ensureRealTab();
      assert.equal(result.targetId, "t-real");
    });
  });
  assert.deepEqual(calls, [["Target.activateTarget", { targetId: "t-real" }]]);
});

test("ensureRealTab returns null when no real tabs exist", async () => {
  await withBrowserRuntime({
    sendCDPMessage() {},
    listTabs: async () => ({ tabs: [{ targetId: "t-chrome", url: "chrome://newtab", title: "", active: true }] })
  }, async () => {
    assert.equal(await helpers.ensureRealTab(), null);
  });
});

test("iframeTarget returns matching iframe target id or null", async () => {
  await withOverrides({
    cdpOverride: async () => ({
      targetInfos: [
        { type: "page", url: "https://example.com", targetId: "page-1" },
        { type: "iframe", url: "https://ads.example.com/banner", targetId: "iframe-1" },
        { type: "iframe", url: "https://example.com/widget", targetId: "iframe-2" }
      ]
    })
  }, async () => {
    assert.equal(await helpers.iframeTarget("ads.example"), "iframe-1");
    assert.equal(await helpers.iframeTarget("widget"), "iframe-2");
    assert.equal(await helpers.iframeTarget("missing"), null);
  });
});

test("snapshotText returns content with full-page action defaults", async () => {
  const snapshots = [];
  await withBrowserRuntime({
    sendCDPMessage() {},
    snapshot: async (options) => {
      snapshots.push(options);
      return { content: "root\n  button \"Save\"", refs: [] };
    }
  }, async () => {
    assert.equal(await helpers.snapshotText(), "root\n  button \"Save\"");
  });
  assert.deepEqual(snapshots, [{ scope: "full_page", includeActionMarks: true, includeStableLocator: true }]);
});

test("snapshotText forwards explicit only_within_viewport scope", async () => {
  const snapshots = [];
  await withBrowserRuntime({
    sendCDPMessage() {},
    snapshot: async (options) => {
      snapshots.push(options);
      return { content: "root", refs: [] };
    }
  }, async () => {
    assert.equal(await helpers.snapshotText({ scope: "only_within_viewport" }), "root");
  });
  assert.deepEqual(snapshots, [{ scope: "only_within_viewport", includeActionMarks: true, includeStableLocator: true }]);
});

test("waitForLoad returns true once readyState is complete", async () => {
  let calls = 0;
  await withOverrides({
    cdpOverride: async (method) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { url: "https://example.com/" } } };
      }
      calls += 1;
      return { result: { value: calls >= 2 ? "complete" : "loading" } };
    },
    now: (() => {
      let value = 0;
      return () => (value += 50);
    })(),
    sleep: async () => {}
  }, async () => {
    assert.equal(await helpers.waitForLoad({ timeout: 1 }), true);
  });
  assert.ok(calls >= 2);
});

test("waitForLoad returns false when timeout elapses", async () => {
  await withOverrides({
    cdpOverride: async () => ({ result: { value: "loading" } }),
    now: (() => {
      let value = 0;
      return () => (value += 500);
    })(),
    sleep: async () => {}
  }, async () => {
    assert.equal(await helpers.waitForLoad({ timeout: 1 }), false);
  });
});

test("waitForNetworkIdle returns false when timeout elapses without idle window", async () => {
  await withBrowserRuntime({ sendCDPMessage() {} }, async () => {
    await withOverrides({
      now: (() => {
        let value = 0;
        return () => (value += 5000);
      })(),
      sleep: async () => {}
    }, async () => {
      assert.equal(await helpers.waitForNetworkIdle({ timeout: 1, idleMs: 100 }), false);
    });
  });
});

test("uploadFile resolves selector via DOM and sets file inputs", async () => {
  const calls = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      calls.push([method, params]);
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: params.selector === "input#file" ? 42 : 0 };
      return {};
    }
  }, async () => {
    await helpers.uploadFile("input#file", "/tmp/a.png");
    await helpers.uploadFile("input#file", ["/tmp/a.png", "/tmp/b.png"]);
  });
  assert.deepEqual(calls.at(-1), ["DOM.setFileInputFiles", { files: ["/tmp/a.png", "/tmp/b.png"], nodeId: 42 }]);
});

test("uploadFile throws when selector matches no element", async () => {
  await withOverrides({
    cdpOverride: async (method) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 0 };
      return {};
    }
  }, async () => {
    await assert.rejects(() => helpers.uploadFile("input#missing", "/tmp/a.png"), /no element for input#missing/);
  });
});

test("dragMouse requires at least two points", async () => {
  await assert.rejects(() => helpers.dragMouse([{ x: 1, y: 2 }]), /at least two points/);
});

test("dragMouse presses, moves through path, and releases at the last point", async () => {
  const events = [];
  await withOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Input.dispatchMouseEvent") {
        events.push({ type: params.type, x: params.x, y: params.y, button: params.button });
      }
      return {};
    }
  }, async () => {
    await helpers.dragMouse([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 }
    ]);
  });
  assert.deepEqual(events, [
    { type: "mousePressed", x: 10, y: 20, button: "left" },
    { type: "mouseMoved", x: 30, y: 40, button: "left" },
    { type: "mouseMoved", x: 50, y: 60, button: "left" },
    { type: "mouseReleased", x: 50, y: 60, button: "left" }
  ]);
});
