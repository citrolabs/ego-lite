import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { click, scroll } from "../../dist/src/driver/pointer.js";

test("click resolves selector offsets without the public elementEval helper", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (
        method === "Runtime.evaluate" &&
        params.objectGroup === "ego-browser"
      ) {
        return { result: { objectId: "object-1" } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { x: 125, y: 225 } } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: { x: 100, y: 200 } } };
      }
      return {};
    },
  });
  try {
    await click({ selector: "#target", x: 12, y: 8 });
  } finally {
    restore();
  }

  const callFunction = calls.find(
    (call) => call.method === "Runtime.callFunctionOn",
  );
  assert.equal(callFunction.params.objectId, "object-1");
  assert.match(
    callFunction.params.functionDeclaration,
    /getBoundingClientRect/,
  );

  assert.ok(
    calls.some(
      (call) =>
        call.method === "Runtime.releaseObject" &&
        call.params.objectId === "object-1",
    ),
  );

  const mouseEvents = calls.filter(
    (call) => call.method === "Input.dispatchMouseEvent",
  );
  assert.deepEqual(
    mouseEvents.map((call) => ({
      type: call.params.type,
      x: call.params.x,
      y: call.params.y,
      button: call.params.button,
      buttons: call.params.buttons,
    })),
    [
      { type: "mouseMoved", x: 112, y: 208, button: "none", buttons: 0 },
      { type: "mousePressed", x: 112, y: 208, button: "left", buttons: 1 },
      { type: "mouseReleased", x: 112, y: 208, button: "left", buttons: 0 },
    ],
  );
});

test("scroll defaults to scrolling down (positive deltaY, DOM wheel convention)", async () => {
  // Regression: the default used to be deltaY -300, which scrolls UP — CDP
  // negates wheel deltas internally, so the DOM convention (positive = down)
  // applies end to end. SKILL.md documents scroll({ dy: 900 }) as a downward
  // scroll, matching scrollBy / scrollToBottomUntil.
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId, timeoutMs) {
      calls.push({ method, params, sessionId, timeoutMs });
      return {};
    },
  });
  try {
    await scroll();
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "Input.dispatchMouseEvent");
  assert.equal(calls[0].params.deltaY, 300);
  assert.equal(calls[0].params.deltaX, 0);
  assert.equal(
    calls[0].timeoutMs,
    15_000,
    "wheel dispatch uses the normal CDP timeout instead of a fragile one-second deadline",
  );
});

test("scroll falls back to DOM scrolling only when wheel dispatch is unsupported", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Input.dispatchMouseEvent") {
        throw new Error("'Input.dispatchMouseEvent' wasn't found");
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { x: 0, y: 450 } } };
      }
      return {};
    },
  });
  try {
    const result = await scroll({ x: 50, y: 60, dx: 10, dy: 450 });
    assert.deepEqual(result, { x: 0, y: 450 });
  } finally {
    restore();
  }

  assert.equal(calls[0].method, "Input.dispatchMouseEvent");
  assert.deepEqual(calls[0].params, {
    type: "mouseWheel",
    x: 50,
    y: 60,
    deltaX: 10,
    deltaY: 450,
  });
  assert.equal(calls[1].method, "Runtime.evaluate");
  assert.match(calls[1].params.expression, /window\.scrollBy/);
});

test("scroll propagates wheel dispatch timeouts instead of silently degrading", async () => {
  // Regression: any error (including timeouts and "user is controlling") used
  // to silently fall back to window.scrollBy, which is not equivalent to a
  // real wheel event and masked the original failure.
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method) {
      calls.push(method);
      if (method === "Input.dispatchMouseEvent") {
        throw new Error("CDP request timed out: Input.dispatchMouseEvent");
      }
      return {};
    },
  });
  try {
    await assert.rejects(() => scroll({ dy: 450 }), /timed out/);
  } finally {
    restore();
  }
  assert.deepEqual(calls, ["Input.dispatchMouseEvent"]);
});

test("scroll propagates user-control errors from wheel dispatch", async () => {
  const restore = setOverrides({
    cdpOverride(method) {
      if (method === "Input.dispatchMouseEvent") {
        throw new Error("user is controlling this task space");
      }
      return {};
    },
  });
  try {
    await assert.rejects(() => scroll(), /user is controlling/);
  } finally {
    restore();
  }
});

function withFakeEgo(run) {
  const originalEgo = globalThis.ego;
  globalThis.ego = { sendCDPMessage: () => {} };
  return run().finally(() => {
    if (originalEgo === undefined) delete globalThis.ego;
    else globalThis.ego = originalEgo;
  });
}

function methodSequence(calls) {
  return calls.map((call) =>
    call.method === "Input.dispatchMouseEvent"
      ? `${call.method}:${call.params.type}`
      : call.method,
  );
}

function isProbeExpression(call) {
  return Boolean(call.params.expression?.includes("__egoBrowserInputProbes"));
}

/**
 * CDP double for a v1 click on a CSS selector with native bindings: the
 * resolving evaluate returns the center, a probe read answers `probeResult`,
 * and native input either succeeds or times out.
 */
function clickOverride({ inputTimesOut = false, probeResult } = {}) {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("probe.dispose();\n        delete")) {
          // finishClickProbe
          return { result: { value: probeResult } };
        }
        // Resolution (buildSelectorCenterJs) plus the probe install
        return { result: { value: { x: 100, y: 200 } } };
      }
      if (method === "Input.dispatchMouseEvent" && inputTimesOut) {
        throw new Error("CDP request timed out: Input.dispatchMouseEvent");
      }
      return {};
    },
  });
  return { calls, restore };
}

test("click resolves a CSS selector and installs its probe in one page call, then never reads it back", async () => {
  const { calls, restore } = clickOverride();
  try {
    await withFakeEgo(() => click("#target"));
  } finally {
    restore();
  }

  assert.deepEqual(
    methodSequence(calls),
    [
      "Runtime.evaluate",
      "Input.dispatchMouseEvent:mouseMoved",
      "Input.dispatchMouseEvent:mousePressed",
      "Input.dispatchMouseEvent:mouseReleased",
    ],
    "a normal click is one resolving page call plus three native input events",
  );
  assert.match(
    calls[0].params.expression,
    /querySelector|document\./,
    "the single page call resolves the selector",
  );
  assert.match(
    calls[0].params.expression,
    /addEventListener\("click", probe\.handler, true\)/,
    "the same page call installs the trusted-click probe before any input",
  );
  assert.match(
    calls[0].params.expression,
    /setTimeout\(\(\) => \{\s*probe\.dispose\(\);/,
    "the probe removes itself so an acknowledged click never reads it back",
  );
  assert.deepEqual(
    calls.slice(1).map((call) => [call.params.x, call.params.y]),
    [
      [100, 200],
      [100, 200],
      [100, 200],
    ],
  );
});

test("click installs the probe before input for coordinate targets and skips the read-back", async () => {
  const { calls, restore } = clickOverride();
  try {
    await withFakeEgo(() => click([30, 40]));
  } finally {
    restore();
  }

  assert.deepEqual(methodSequence(calls), [
    "Runtime.evaluate",
    "Input.dispatchMouseEvent:mouseMoved",
    "Input.dispatchMouseEvent:mousePressed",
    "Input.dispatchMouseEvent:mouseReleased",
  ]);
  assert(isProbeExpression(calls[0]), "the probe is installed before input");
  assert.match(calls[0].params.expression, /\{"x":30,"y":40\}/);
});

test("click reads the probe and falls back to synthetic events only after a dispatch timeout", async () => {
  const { calls, restore } = clickOverride({
    inputTimesOut: true,
    probeResult: { seen: false, fallback: true },
  });
  try {
    // Does not throw: the fallback reached the element.
    await withFakeEgo(() => click("#target"));
  } finally {
    restore();
  }

  assert.deepEqual(methodSequence(calls), [
    "Runtime.evaluate",
    "Input.dispatchMouseEvent:mouseMoved",
    "Runtime.evaluate",
  ]);
  assert(isProbeExpression(calls[0]), "the probe was installed before input");
  const finish = calls[2].params.expression;
  assert.match(finish, /probe\.dispose\(\)/);
  assert.match(finish, /if \(probe\.seen \|\| !probe\.target\) return/);
  assert.match(finish, /dispatchEvent\(new MouseEvent\("click"/);
});

test("click treats a trusted click that landed before the dispatch timeout as delivered", async () => {
  // The renderer can deliver the event and still miss the CDP deadline. The
  // probe installed before dispatch has seen the click, so no synthetic click
  // is replayed and the timeout is absorbed.
  const { calls, restore } = clickOverride({
    inputTimesOut: true,
    probeResult: { seen: true, fallback: false },
  });
  try {
    await withFakeEgo(() => click("#target"));
  } finally {
    restore();
  }

  assert.deepEqual(methodSequence(calls), [
    "Runtime.evaluate",
    "Input.dispatchMouseEvent:mouseMoved",
    "Runtime.evaluate",
  ]);
  assert.equal(
    calls.filter(isProbeExpression).length,
    2,
    "the probe is installed once before input and read once after the timeout",
  );
});

test("click rethrows a dispatch timeout when the probe has no element to fall back to", async () => {
  const { restore } = clickOverride({
    inputTimesOut: true,
    probeResult: { seen: false, fallback: false },
  });
  try {
    await assert.rejects(
      () => withFakeEgo(() => click("#target")),
      /CDP request timed out: Input\.dispatchMouseEvent/,
    );
  } finally {
    restore();
  }
});

test("click falls back to the shared resolver when the fast path finds no element", async () => {
  // The combined resolve-and-probe evaluate searches the default session only.
  // A miss there must not be reported as "not found": the shared resolver
  // decides, and when it resolves the element the probe is installed in a
  // call of its own before any input.
  const calls = [];
  let evaluations = 0;
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        evaluations += 1;
        if (evaluations === 1) return { result: { value: null } };
        if (params.expression.includes("__egoBrowserInputProbes")) {
          return { result: { value: true } };
        }
        return { result: { value: { x: 70, y: 80 } } };
      }
      return {};
    },
  });
  try {
    await withFakeEgo(() => click("#inside-frame"));
  } finally {
    restore();
  }

  assert.deepEqual(methodSequence(calls), [
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Runtime.evaluate",
    "Input.dispatchMouseEvent:mouseMoved",
    "Input.dispatchMouseEvent:mousePressed",
    "Input.dispatchMouseEvent:mouseReleased",
  ]);
  assert(
    isProbeExpression(calls[0]),
    "the fast path tried to resolve and probe at once",
  );
  assert.equal(
    isProbeExpression(calls[1]),
    false,
    "the shared resolver evaluates the selector without a probe",
  );
  assert(isProbeExpression(calls[2]), "the probe is installed before input");
  assert.match(calls[2].params.expression, /\{"x":70,"y":80\}/);
  assert.deepEqual(
    calls.slice(3).map((call) => [call.params.x, call.params.y]),
    [
      [70, 80],
      [70, 80],
      [70, 80],
    ],
  );
});

test("click reports a selector missing from every session with the resolver's wording", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { value: null } };
      return {};
    },
  });
  try {
    await assert.rejects(
      () => withFakeEgo(() => click("#missing")),
      (error) => {
        assert.equal(error.name, "ElementResolutionError");
        assert.equal(error.kind, "transient");
        assert.equal(error.message, "Element not found: #missing");
        return true;
      },
    );
  } finally {
    restore();
  }
  assert.deepEqual(
    methodSequence(calls),
    ["Runtime.evaluate", "Runtime.evaluate"],
    "the fast path misses, the shared resolver reports",
  );
});
