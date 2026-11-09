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

test("click triggers probe fallback when CDP click is not trusted", async () => {
  const originalEgo = globalThis.ego;
  globalThis.ego = { sendCDPMessage: () => {} };
  let probeEvaluateCount = 0;
  const evaluateExpressions = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      if (method === "Runtime.evaluate") {
        // Probe calls contain __egoBrowserInputProbes; element resolution does not
        if (params.expression?.includes("__egoBrowserInputProbes")) {
          probeEvaluateCount++;
          evaluateExpressions.push(params.expression);
          if (probeEvaluateCount === 1) {
            // installClickProbe — elementFromPoint returns truthy
            return { result: { value: true } };
          }
          // finishClickProbe — simulate CDP click was NOT seen
          return { result: { value: { seen: false, fallback: true } } };
        }
        // Element resolution (buildSelectorCenterJs) — return center point
        return { result: { value: { x: 100, y: 200 } } };
      }
      // Input.dispatchMouseEvent calls proceed normally
      return {};
    },
  });
  try {
    await click("#target");
  } finally {
    restore();
    if (originalEgo === undefined) delete globalThis.ego;
    else globalThis.ego = originalEgo;
  }

  // 2 probe Runtime.evaluate calls: install + finish (element resolution excluded)
  assert.equal(
    probeEvaluateCount,
    2,
    "Runtime.evaluate called for install and finish probes",
  );
  assert.match(
    evaluateExpressions[0],
    /__egoBrowserInputProbes/,
    "install expression sets up click probe",
  );
  assert.match(
    evaluateExpressions[1],
    /dispatchEvent/,
    "finish expression contains fallback mouse events",
  );
  assert.match(
    evaluateExpressions[1],
    /MouseEvent/,
    "finish expression dispatches MouseEvent in fallback",
  );
});

test("click absorbs CDP timeout when probe fallback succeeds", async () => {
  const originalEgo = globalThis.ego;
  globalThis.ego = { sendCDPMessage: () => {} };
  let probeEvaluateCount = 0;
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      if (method === "Runtime.evaluate") {
        // Probe calls contain __egoBrowserInputProbes; element resolution does not
        if (params.expression?.includes("__egoBrowserInputProbes")) {
          probeEvaluateCount++;
          if (probeEvaluateCount === 1) {
            return { result: { value: true } };
          }
          // Fallback succeeded
          return { result: { value: { seen: false, fallback: true } } };
        }
        // Element resolution (buildSelectorCenterJs) — return center point
        return { result: { value: { x: 100, y: 200 } } };
      }
      if (method === "Input.dispatchMouseEvent") {
        // Simulate CDP timeout — the browser couldn't dispatch the event
        throw new Error("CDP request timed out: Input.dispatchMouseEvent");
      }
      return {};
    },
  });
  try {
    // Should NOT throw — timeout is absorbed because fallback succeeded
    await click("#target");
  } finally {
    restore();
    if (originalEgo === undefined) delete globalThis.ego;
    else globalThis.ego = originalEgo;
  }

  assert.ok(
    probeEvaluateCount >= 2,
    "probe install and finish were called despite CDP timeout",
  );
});
