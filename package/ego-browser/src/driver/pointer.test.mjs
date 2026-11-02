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

/**
 * A one-element page that runs the real page-side expressions. `rect` is where
 * the element starts; `scrollable: false` models content that cannot move, such
 * as a fixed element, and otherwise scrollIntoView centers it in the viewport.
 */
function fakePage({ rect, scrollable = true }) {
  const view = { innerWidth: 800, innerHeight: 600 };
  const current = { ...rect };
  const scrolls = [];
  const domRect = () => ({
    x: current.left,
    y: current.top,
    left: current.left,
    top: current.top,
    width: current.width,
    height: current.height,
    right: current.left + current.width,
    bottom: current.top + current.height,
  });
  const element = {
    ownerDocument: { defaultView: view },
    getBoundingClientRect: domRect,
    getClientRects: () => [domRect()],
    scrollIntoView(options) {
      scrolls.push(options);
      if (!scrollable) return;
      current.top = (view.innerHeight - current.height) / 2;
      current.left = (view.innerWidth - current.width) / 2;
    },
  };
  const document = {
    querySelectorAll: (selector) => (selector === "*" ? [] : [element]),
    elementFromPoint: () => element,
    addEventListener() {},
    removeEventListener() {},
  };
  const run = (source, ...args) =>
    new Function(
      "document",
      "window",
      "innerWidth",
      "innerHeight",
      "setTimeout",
      "clearTimeout",
      "__args",
      `return (${source});`,
    )(
      document,
      view,
      view.innerWidth,
      view.innerHeight,
      () => 0,
      () => {},
      args,
    );
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        if (params.objectGroup === "ego-browser") {
          return { result: { objectId: "object-1" } };
        }
        return { result: { value: run(params.expression) } };
      }
      if (method === "Runtime.callFunctionOn") {
        const args = params.arguments.map((arg) => arg.value);
        const value = new Function(
          "__fn",
          "__args",
          "return __fn.apply(this, __args);",
        ).call(element, run(params.functionDeclaration), args);
        return { result: { value } };
      }
      return {};
    },
  });
  return { calls, restore, scrolls };
}

function dispatchedPoints(calls) {
  return calls
    .filter((call) => call.method === "Input.dispatchMouseEvent")
    .map((call) => [call.params.x, call.params.y]);
}

const CENTER_BELOW_FOLD = { left: 100, top: 590, width: 100, height: 40 };
const FULLY_BELOW_FOLD = { left: 100, top: 2000, width: 100, height: 40 };
const CENTERED_POINT = [400, 300];

for (const [name, target] of [
  ["a CSS selector", "#target"],
  ["a loc=css locator", "loc=css:#target"],
  ["a selector object", { selector: "#target" }],
]) {
  test(`click scrolls ${name} into view when its center is below the fold`, async () => {
    const { calls, restore, scrolls } = fakePage({ rect: CENTER_BELOW_FOLD });
    try {
      await withFakeEgo(() => click(target));
    } finally {
      restore();
    }
    assert.equal(scrolls.length, 1);
    assert.deepEqual(dispatchedPoints(calls), [
      CENTERED_POINT,
      CENTERED_POINT,
      CENTERED_POINT,
    ]);
  });
}

test("click on a CSS selector scrolls and probes in its one resolving page call", async () => {
  const { calls, restore, scrolls } = fakePage({ rect: FULLY_BELOW_FOLD });
  try {
    await withFakeEgo(() => click("#target"));
  } finally {
    restore();
  }
  assert.deepEqual(scrolls, [
    { block: "center", inline: "center", behavior: "instant" },
  ]);
  assert.deepEqual(methodSequence(calls), [
    "Runtime.evaluate",
    "Input.dispatchMouseEvent:mouseMoved",
    "Input.dispatchMouseEvent:mousePressed",
    "Input.dispatchMouseEvent:mouseReleased",
  ]);
});

test("click leaves an element whose center is in the viewport where it is", async () => {
  const { calls, restore, scrolls } = fakePage({
    rect: { left: 100, top: 570, width: 100, height: 40 },
  });
  try {
    await withFakeEgo(() => click("#target"));
  } finally {
    restore();
  }
  assert.deepEqual(scrolls, []);
  assert.deepEqual(dispatchedPoints(calls)[0], [150, 590]);
});

test("click uses the visible part of an element that cannot scroll to its center", async () => {
  for (const target of ["#target", "loc=css:#target"]) {
    const { calls, restore } = fakePage({
      rect: CENTER_BELOW_FOLD,
      scrollable: false,
    });
    try {
      await withFakeEgo(() => click(target));
    } finally {
      restore();
    }
    assert.deepEqual(dispatchedPoints(calls)[0], [150, 595], String(target));
  }
});

test("click reports an element it cannot bring into the viewport instead of succeeding", async () => {
  for (const target of [
    "#target",
    "loc=css:#target",
    { selector: "#target", x: 4, y: 4 },
  ]) {
    const { calls, restore } = fakePage({
      rect: FULLY_BELOW_FOLD,
      scrollable: false,
    });
    try {
      await assert.rejects(
        () => withFakeEgo(() => click(target)),
        (error) => {
          assert.equal(error.name, "ElementResolutionError");
          assert.equal(error.kind, "transient");
          assert.match(error.message, /not visible in the viewport/);
          return true;
        },
      );
    } finally {
      restore();
    }
    assert.deepEqual(dispatchedPoints(calls), [], JSON.stringify(target));
  }
});

test("click scrolls a selector-relative point back into the viewport", async () => {
  const { calls, restore, scrolls } = fakePage({ rect: FULLY_BELOW_FOLD });
  try {
    await withFakeEgo(() => click({ selector: "#target", x: 4, y: 6 }));
  } finally {
    restore();
  }
  assert.equal(scrolls.length, 1);
  // Centered element: left 350, top 280, plus the caller's offset.
  assert.deepEqual(dispatchedPoints(calls)[0], [354, 286]);
});

test("click does not second-guess explicit coordinates", async () => {
  const { calls, restore, scrolls } = fakePage({ rect: CENTER_BELOW_FOLD });
  try {
    await withFakeEgo(() => click([30, 900]));
  } finally {
    restore();
  }
  assert.deepEqual(scrolls, []);
  assert.deepEqual(dispatchedPoints(calls)[0], [30, 900]);
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
        // Resolution (clickPointForElement) plus the probe install
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
  assert.match(
    calls[2].params.expression,
    /70 >= 0 && 80 >= 0/,
    "the resolved point is checked against the viewport",
  );
  assert(isProbeExpression(calls[3]), "the probe is installed before input");
  assert.match(calls[3].params.expression, /\{"x":70,"y":80\}/);
  assert.deepEqual(
    calls.slice(4).map((call) => [call.params.x, call.params.y]),
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
