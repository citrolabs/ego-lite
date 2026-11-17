import test from "node:test";
import assert from "node:assert/strict";

import {
  clickInPage,
  clickPointInPage,
  mouseButtonInPage,
} from "../dist/src/driver/page-actions.js";
import { RefMap } from "../dist/src/ref-map.js";

/**
 * Services for a top-level raw-selector click: the strict resolver counts and
 * resolves the selector with Runtime.evaluate, the action point comes from the
 * expression that settles layout, and every other page call answers `respond`.
 */
function topLevelClickServices({
  respond = () => ({ ok: true }),
  point = { x: 10, y: 20 },
} = {}) {
  const calls = [];
  const services = {
    calls,
    async cdp(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Runtime.evaluate") {
        return params.returnByValue === false
          ? { result: { objectId: "button-1" } }
          : { result: { value: 1 } };
      }
      if (method === "Runtime.callFunctionOn") {
        const value = params.functionDeclaration.includes("setTimeout(finish")
          ? point
          : respond(params);
        return { result: { value } };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };
  return services;
}

function actionSequence(calls) {
  return calls
    .filter(([method]) => method !== "Runtime.evaluate")
    .map(([method, params]) =>
      method === "Input.dispatchMouseEvent"
        ? `${method}:${params.type}`
        : method,
    );
}

function pageCalls(calls) {
  return calls
    .filter(([method]) => method === "Runtime.callFunctionOn")
    .map(([, params]) => params.functionDeclaration);
}

test("Page click validates a top-level target once before the move and once before the press", async () => {
  const services = topLevelClickServices();

  await clickInPage(services, "session:page", new RefMap(), "#button");

  assert.deepEqual(actionSequence(services.calls), [
    "Runtime.callFunctionOn",
    "Input.dispatchMouseEvent:mouseMoved",
    "Runtime.callFunctionOn",
    "Input.dispatchMouseEvent:mousePressed",
    "Input.dispatchMouseEvent:mouseReleased",
    "Runtime.releaseObject",
  ]);
  const [pointCheck, pressCheck] = pageCalls(services.calls);
  for (const check of [pointCheck, pressCheck]) {
    assert.match(
      check,
      /isActionTargetDisabled\(this\)/,
      "each page call verifies the enabled state",
    );
    assert.match(
      check,
      /interceptingElementAtPoint\(this, point\)/,
      "each page call verifies the hit target",
    );
  }
  assert.match(pointCheck, /setTimeout\(finish, 100\)/);
  assert.doesNotMatch(
    pressCheck,
    /setTimeout\(finish, 100\)/,
    "the pre-press recheck does not wait for layout again",
  );
  const pressEvents = services.calls.filter(
    ([method, params]) =>
      method === "Input.dispatchMouseEvent" && params.type !== "mouseMoved",
  );
  assert(
    pressEvents.every(([, params]) => params.x === 10 && params.y === 20),
    "press and release use the resolved action point",
  );
});

test("Page click fails before any pointer input when the element is disabled", async () => {
  const services = topLevelClickServices({
    point: { error: "element is disabled" },
  });

  await assert.rejects(
    () => clickInPage(services, "session:page", new RefMap(), "#button"),
    (error) => {
      assert.equal(error.name, "ElementResolutionError");
      assert.equal(error.kind, "transient");
      assert.equal(error.message, "page.click failed: element is disabled");
      return true;
    },
  );
  assert.equal(
    services.calls.some(([method]) => method === "Input.dispatchMouseEvent"),
    false,
  );
});

test("Page click fails closed when the pre-press recheck reports an interceptor", async () => {
  const services = topLevelClickServices({
    respond: () => ({
      error: '<div id="hover-overlay"> intercepts pointer events',
    }),
  });

  await assert.rejects(
    () => clickInPage(services, "session:page", new RefMap(), "#button"),
    (error) => {
      assert.equal(error.name, "ElementResolutionError");
      assert.equal(error.kind, "transient");
      assert.equal(
        error.message,
        'page.click failed: <div id="hover-overlay"> intercepts pointer events',
      );
      return true;
    },
  );
  assert.deepEqual(
    actionSequence(services.calls),
    [
      "Runtime.callFunctionOn",
      "Input.dispatchMouseEvent:mouseMoved",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ],
    "the pointer moved but no press reached the page",
  );
});

test("Page click force skips the hit test but still rejects a disabled element", async () => {
  const services = topLevelClickServices();

  await clickInPage(services, "session:page", new RefMap(), "#button", {
    force: true,
  });

  const checks = pageCalls(services.calls);
  for (const check of checks) {
    assert.match(check, /isActionTargetDisabled\(this\)/);
    assert.doesNotMatch(check, /interceptingElementAtPoint\(this, point\)/);
  }
  assert.match(
    checks.at(-1),
    /nativeSelectMenuAt\(hitElementAtPoint\(this, point\)\)/,
    "force does not change the press, so the native select check still runs",
  );
  assert.equal(
    services.calls.filter(
      ([method, params]) =>
        method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
    ).length,
    1,
  );
});

test("Page click rechecks the target before every press of a multi-click", async () => {
  const services = topLevelClickServices();

  await clickInPage(services, "session:page", new RefMap(), "#button", {
    clickCount: 2,
  });

  assert.deepEqual(actionSequence(services.calls), [
    "Runtime.callFunctionOn",
    "Input.dispatchMouseEvent:mouseMoved",
    "Runtime.callFunctionOn",
    "Input.dispatchMouseEvent:mousePressed",
    "Input.dispatchMouseEvent:mouseReleased",
    "Runtime.callFunctionOn",
    "Input.dispatchMouseEvent:mousePressed",
    "Input.dispatchMouseEvent:mouseReleased",
    "Runtime.releaseObject",
  ]);
  const presses = services.calls
    .filter(
      ([method, params]) =>
        method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
    )
    .map(([, params]) => params.clickCount);
  assert.deepEqual(presses, [1, 2]);
});

test("Page click translates same-process iframe coordinates to the Page viewport", async () => {
  const calls = [];
  const states = [];
  const services = {
    async cdp(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Accessibility.getFullAXTree") {
        return params.frameId === "frame-child"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Run iframe action" },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "iframe-button" } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        if (params.functionDeclaration.includes("clickTargetActionable")) {
          return { result: { value: { ok: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "DOM.getFrameOwner") {
        return { backendNodeId: 90 };
      }
      if (method === "DOM.getBoxModel") {
        const callCount = calls.filter(
          ([calledMethod]) => calledMethod === "DOM.getBoxModel",
        ).length;
        const y = callCount === 1 ? 200 : 219;
        return {
          model: { content: [100, y, 300, y, 300, y + 200, 100, y + 200] },
        };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState(state) {
      states.push(state);
    },
    async sleep() {},
  };

  await clickInPage(
    services,
    "session:page",
    new RefMap(),
    'loc=role:button[name="Run iframe action"]',
    {},
    0,
    new Map([["frame-child", "session:page"]]),
  );

  const pointerEvents = calls
    .filter(([method]) => method === "Input.dispatchMouseEvent")
    .map(([, params]) => params);
  assert.equal(pointerEvents.length, 4);
  assert(
    pointerEvents[0].x === 110 && pointerEvents[0].y === 220,
    "the initial move uses the first top-level Page coordinates",
  );
  assert(
    pointerEvents.slice(1).every(({ x, y }) => x === 110 && y === 239),
    "the press uses coordinates translated again after the pointer move",
  );
  const hitTest = calls.find(
    ([method, params]) =>
      method === "Runtime.callFunctionOn" &&
      params.functionDeclaration.includes("isConnected"),
  );
  assert.match(
    hitTest[1].functionDeclaration,
    /elementsFromPoint\(point\.x, point\.y\)/,
    "the iframe-local actionability check uses its own document",
  );
  const moveIndex = calls.findLastIndex(
    ([method, params]) =>
      method === "Input.dispatchMouseEvent" && params.type === "mouseMoved",
  );
  const initialMoveIndex = calls.findIndex(
    ([method, params]) =>
      method === "Input.dispatchMouseEvent" && params.type === "mouseMoved",
  );
  const pressIndex = calls.findIndex(
    ([method, params]) =>
      method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
  );
  assert(
    calls
      .slice(initialMoveIndex + 1, moveIndex)
      .some(
        ([method, params]) =>
          method === "Runtime.callFunctionOn" &&
          params.functionDeclaration.includes("elementsFromPoint"),
      ),
    "iframe clicks recheck the frame-local hit target after the initial pointer move",
  );
  assert.equal(
    calls
      .slice(moveIndex + 1, pressIndex)
      .some(([method]) => method === "Runtime.callFunctionOn"),
    false,
    "same-process iframe input keeps mouseMoved and mousePressed contiguous",
  );
  assert.deepEqual(states, ["Clicking element"]);
});

test("Page click keeps raw-selector OOPIF input local but renders its cursor in the Page viewport", async () => {
  const calls = [];
  const cursorPoints = [];
  const services = {
    async cdp(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Accessibility.getFullAXTree") {
        return sessionId === "session:frame"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Run OOPIF action" },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === "Runtime.evaluate") {
        if (params.returnByValue === false) {
          return sessionId === "session:frame"
            ? { result: { objectId: "iframe-button" } }
            : { result: {} };
        }
        return {
          result: {
            value: sessionId === "session:frame" ? 1 : 0,
          },
        };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "iframe-button" } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        if (params.functionDeclaration.includes("clickTargetActionable")) {
          return { result: { value: { ok: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "frame-page" },
            childFrames: [{ frame: { id: "frame-child" } }],
          },
        };
      }
      if (method === "DOM.getFrameOwner") {
        assert.equal(sessionId, "session:page");
        assert.equal(params.frameId, "frame-child");
        return { backendNodeId: 90 };
      }
      if (method === "DOM.getBoxModel") {
        assert.equal(sessionId, "session:page");
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    async showAgentMousePosition(x, y) {
      cursorPoints.push({ x, y });
    },
    async showAgentTaskState() {},
    async sleep() {},
  };

  await clickInPage(
    services,
    "session:page",
    new RefMap(),
    "#iframe-button",
    {},
    0,
    new Map([["frame-child", "session:frame"]]),
  );

  const pointerEvents = calls
    .filter(([method]) => method === "Input.dispatchMouseEvent")
    .map(([, params, sessionId]) => ({ params, sessionId }));
  assert(
    pointerEvents.every(
      ({ params, sessionId }) =>
        sessionId === "session:frame" && params.x === 10 && params.y === 20,
    ),
    "OOPIF input stays in the child target's local viewport",
  );
  assert.deepEqual(cursorPoints, [{ x: 110, y: 220 }]);
  const pressIndex = calls.findIndex(
    ([method, params]) =>
      method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
  );
  const selectCheck = calls.findIndex(
    ([method, params]) =>
      method === "Runtime.callFunctionOn" &&
      params.functionDeclaration.includes(
        "nativeSelectMenuAt(hitElementAtPoint",
      ),
  );
  assert(
    selectCheck >= 0 && selectCheck < pressIndex,
    "the first OOPIF press is checked for a native select",
  );
  assert.equal(calls[selectCheck][2], "session:frame");
});

test("Page click renders an OOPIF cursor when FrameTree omits its ancestor iframe", async () => {
  const calls = [];
  const cursorPoints = [];
  const services = {
    async cdp(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Accessibility.getFullAXTree") {
        return sessionId === "session:map"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Run nested OOPIF action" },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "iframe-button" } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        if (params.functionDeclaration.includes("clickTargetActionable")) {
          return { result: { value: { ok: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "frame-page" },
          },
        };
      }
      if (method === "DOM.getFrameOwner") {
        if (params.frameId === "frame-map") {
          assert.equal(sessionId, "session:runner");
          return { backendNodeId: 90 };
        }
        if (params.frameId === "frame-demo") {
          assert.equal(sessionId, "session:page");
          return { backendNodeId: 91 };
        }
        throw new Error(`unexpected frame owner ${params.frameId}`);
      }
      if (method === "DOM.getBoxModel") {
        const [x, y] = params.backendNodeId === 90 ? [100, 200] : [300, 400];
        return {
          model: { content: [x, y, x + 200, y, x + 200, y + 200, x, y + 200] },
        };
      }
      return {};
    },
    async showAgentMousePosition(x, y) {
      cursorPoints.push({ x, y });
    },
    async showAgentTaskState() {},
    async sleep() {},
  };

  const iframeSessions = new Map([
    ["frame-demo", "session:runner"],
    ["frame-map", "session:map"],
  ]);
  iframeSessions.parentFrameIds = new Map([
    ["frame-demo", "frame-page"],
    ["frame-map", "frame-demo"],
  ]);

  await clickInPage(
    services,
    "session:page",
    new RefMap(),
    'loc=role:button[name="Run nested OOPIF action"]',
    {},
    0,
    iframeSessions,
  );

  const pointerEvents = calls
    .filter(([method]) => method === "Input.dispatchMouseEvent")
    .map(([, params, sessionId]) => ({ params, sessionId }));
  assert(
    pointerEvents.every(
      ({ params, sessionId }) =>
        sessionId === "session:map" && params.x === 10 && params.y === 20,
    ),
    "OOPIF input stays in the child target's local viewport",
  );
  assert.deepEqual(cursorPoints, [{ x: 410, y: 620 }]);
});

const DROPDOWN = {
  locator: "select#dropdown",
  options: ["Option 1", "Option 2"],
  optionCount: 2,
};

function assertNativeSelectRefusal(actionName, locatorText) {
  return (error) => {
    assert.equal(error.name, "ElementResolutionError");
    assert.equal(error.kind, "permanent", "retrying cannot help");
    assert(
      error.message.startsWith(
        `${actionName} refused to press the left mouse button`,
      ),
      error.message,
    );
    assert(error.message.includes(locatorText), error.message);
    return true;
  };
}

function pressCount(calls) {
  return calls.filter(
    ([method, params]) =>
      method === "Input.dispatchMouseEvent" && params.type === "mousePressed",
  ).length;
}

test("Page click refuses a left press that would open a native select menu", async () => {
  const services = topLevelClickServices({
    respond: () => ({ nativeSelect: DROPDOWN }),
  });

  await assert.rejects(
    () => clickInPage(services, "session:page", new RefMap(), "#dropdown"),
    assertNativeSelectRefusal(
      "page.click",
      'page.selectOption("select#dropdown", { label: "..." }) instead. Options: "Option 1", "Option 2".',
    ),
  );
  assert.equal(pressCount(services.calls), 0);
  assert.match(
    pageCalls(services.calls).at(-1),
    /nativeSelectMenuAt\(hitElementAtPoint\(this, point\)\)/,
    "the check looks at the element under the press point, not the target",
  );
});

test("Page click with force is refused on a native select as well", async () => {
  const services = topLevelClickServices({
    respond: () => ({ nativeSelect: DROPDOWN }),
  });

  await assert.rejects(
    () =>
      clickInPage(services, "session:page", new RefMap(), "#dropdown", {
        force: true,
      }),
    assertNativeSelectRefusal("page.click", "select#dropdown"),
  );
  assert.equal(pressCount(services.calls), 0);
});

test("Page right click and middle click skip the native select check", async () => {
  for (const button of ["right", "middle"]) {
    const services = topLevelClickServices();
    await clickInPage(services, "session:page", new RefMap(), "#dropdown", {
      button,
    });
    for (const check of pageCalls(services.calls)) {
      assert.doesNotMatch(check, /nativeSelectMenuAt\(/);
    }
    assert.equal(pressCount(services.calls), 1);
  }
});

/** The page-side hit test answers with a JSON verdict string. */
function selectVerdict(nativeSelect) {
  return { result: { value: JSON.stringify({ nativeSelect }) } };
}

/**
 * Services for coordinate presses. `nativeSelect` is what the hit test finds
 * at the point (null: not a drop-down select); `respond` may answer any CDP
 * call first and returns undefined to fall through.
 */
function pointServices(nativeSelect, respond = () => undefined) {
  const calls = [];
  return {
    calls,
    async cdp(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      const response = respond(method, params, sessionId);
      if (response !== undefined) return response;
      if (method === "Runtime.evaluate") return selectVerdict(nativeSelect);
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };
}

test("Page mouse click refuses coordinates on a native select", async () => {
  const services = pointServices({
    locator: null,
    options: [],
    optionCount: 0,
  });

  await assert.rejects(
    () => clickPointInPage(services, "session:page", 40, 50),
    assertNativeSelectRefusal(
      "page.mouse.click",
      "with a selector or snapshot ref that matches only this <select>",
    ),
  );
  assert.equal(
    services.calls.some(([method]) => method === "Input.dispatchMouseEvent"),
    false,
    "no pointer input reaches the page",
  );
  const [, params, sessionId] = services.calls[0];
  assert.equal(sessionId, "session:page");
  assert.match(params.expression, /let x = 40;\s+let y = 50;/);
  assert.match(params.expression, /contentDocument/);
});

test("Page mouse click elsewhere and right clicks dispatch normally", async () => {
  const clear = pointServices(null);
  await clickPointInPage(clear, "session:page", 40, 50);
  assert.equal(pressCount(clear.calls), 1);

  const right = pointServices(DROPDOWN);
  await clickPointInPage(right, "session:page", 40, 50, { button: "right" });
  assert.equal(
    right.calls.some(([method]) => method === "Runtime.evaluate"),
    false,
  );
  assert.equal(pressCount(right.calls), 1);
});

test("Page mouse down checks only left presses for a native select", async () => {
  const blocked = pointServices(DROPDOWN);
  await assert.rejects(
    () => mouseButtonInPage(blocked, "session:page", "mousePressed", 40, 50, 1),
    assertNativeSelectRefusal("page.mouse.down", "select#dropdown"),
  );
  assert.equal(pressCount(blocked.calls), 0);

  const release = pointServices(DROPDOWN);
  await mouseButtonInPage(release, "session:page", "mouseReleased", 40, 50, 0);
  assert.equal(
    release.calls.some(([method]) => method === "Runtime.evaluate"),
    false,
    "releasing never opens a menu",
  );
});

/**
 * A page whose point (140, 250) is inside an iframe the page cannot read. The
 * iframe's content box starts at (100, 200); `inFrame` answers the hit test
 * that runs inside the frame.
 */
function crossOriginFrameServices(inFrame, respond = () => undefined) {
  return pointServices(null, (method, params, sessionId) => {
    const response = respond(method, params, sessionId);
    if (response !== undefined) return response;
    if (method === "Runtime.evaluate") {
      const inPageDocument =
        sessionId === "session:page" && params.contextId === undefined;
      return inPageDocument
        ? { result: { type: "object", objectId: "iframe-1" } }
        : inFrame;
    }
    if (method === "DOM.describeNode") {
      return { node: { nodeName: "IFRAME", frameId: "frame-1" } };
    }
    if (method === "DOM.getBoxModel") {
      return { model: { content: [100, 200, 400, 200, 400, 500, 100, 500] } };
    }
    if (method === "Page.createIsolatedWorld") {
      return { executionContextId: 7 };
    }
    return undefined;
  });
}

/** A `respond` hook that answers one CDP method and leaves the rest alone. */
function answer(target, response) {
  return (method) => (method === target ? response : undefined);
}

function assertUncheckedRefusal(actionName, reason) {
  return (error) => {
    assert.equal(error.name, "ElementResolutionError");
    assert.equal(error.kind, "transient");
    assert(
      error.message.startsWith(
        `${actionName} failed: could not verify that the left press would not open a native <select> menu`,
      ),
      error.message,
    );
    if (reason) assert(error.message.includes(reason), error.message);
    return true;
  };
}

function frameEvaluations(calls) {
  return calls.filter(
    ([method, params, sessionId]) =>
      method === "Runtime.evaluate" &&
      (sessionId !== "session:page" || params.contextId !== undefined),
  );
}

test("Page mouse click checks a native select inside an out-of-process iframe in that frame's session", async () => {
  const frameSessions = async () => new Map([["frame-1", "session:frame"]]);
  const blocked = crossOriginFrameServices(selectVerdict(DROPDOWN));

  await assert.rejects(
    () =>
      clickPointInPage(
        blocked,
        "session:page",
        140,
        250,
        {},
        0,
        0,
        frameSessions,
      ),
    assertNativeSelectRefusal("page.mouse.click", "select#dropdown"),
  );
  assert.equal(
    blocked.calls.some(([method]) => method === "Input.dispatchMouseEvent"),
    false,
    "no pointer input reaches the page",
  );
  const [[, params, sessionId]] = frameEvaluations(blocked.calls);
  assert.equal(sessionId, "session:frame");
  assert.equal(params.contextId, undefined);
  assert.match(
    params.expression,
    /let x = 40;\s+let y = 50;/,
    "the point is translated into the frame's viewport",
  );
  assert(
    blocked.calls.some(
      ([method, releaseParams]) =>
        method === "Runtime.releaseObject" &&
        releaseParams.objectId === "iframe-1",
    ),
    "the iframe handle is released",
  );

  const down = crossOriginFrameServices(selectVerdict(DROPDOWN));
  await assert.rejects(
    () =>
      mouseButtonInPage(
        down,
        "session:page",
        "mousePressed",
        140,
        250,
        1,
        {},
        0,
        frameSessions,
      ),
    assertNativeSelectRefusal("page.mouse.down", "select#dropdown"),
  );
  assert.equal(pressCount(down.calls), 0);

  const clear = crossOriginFrameServices(selectVerdict(null));
  await clickPointInPage(
    clear,
    "session:page",
    140,
    250,
    {},
    0,
    0,
    frameSessions,
  );
  const press = clear.calls.find(
    ([method, pressParams]) =>
      method === "Input.dispatchMouseEvent" &&
      pressParams.type === "mousePressed",
  );
  assert.deepEqual(
    [press[1].x, press[1].y, press[2]],
    [140, 250, "session:page"],
    "a cleared press is dispatched at the original Page coordinates",
  );
});

test("Page mouse click checks a same-process iframe with an unreadable document in that frame's context", async () => {
  const frameSessions = async () => new Map([["frame-1", "session:page"]]);
  const services = crossOriginFrameServices(selectVerdict(DROPDOWN));

  await assert.rejects(
    () =>
      clickPointInPage(
        services,
        "session:page",
        140,
        250,
        {},
        0,
        0,
        frameSessions,
      ),
    assertNativeSelectRefusal("page.mouse.click", "select#dropdown"),
  );
  assert.equal(pressCount(services.calls), 0);
  const world = services.calls.find(
    ([method]) => method === "Page.createIsolatedWorld",
  );
  assert.equal(world[1].frameId, "frame-1");
  assert.equal(world[2], "session:page");
  const [[, params, sessionId]] = frameEvaluations(services.calls);
  assert.equal(sessionId, "session:page");
  assert.equal(params.contextId, 7);
  assert.match(params.expression, /let x = 40;\s+let y = 50;/);
});

test("Page mouse click fails closed when the frame under the point cannot be inspected", async () => {
  const cases = [
    [
      "no session and no execution context for the frame",
      crossOriginFrameServices(selectVerdict(null), (method) => {
        if (method === "Page.createIsolatedWorld") {
          throw new Error("No frame for given id found");
        }
      }),
      undefined,
      "the point is inside an iframe that could not be inspected: No frame for given id found",
    ],
    [
      "frame sessions cannot be listed",
      crossOriginFrameServices(selectVerdict(null)),
      async () => {
        throw new Error("Page did not answer");
      },
      "could not be inspected: Page did not answer",
    ],
    [
      "the iframe has no box",
      crossOriginFrameServices(
        selectVerdict(null),
        answer("DOM.getBoxModel", {}),
      ),
      async () => new Map([["frame-1", "session:frame"]]),
      "the iframe has no box",
    ],
    [
      "the frame's hit test returns nothing",
      crossOriginFrameServices({ result: { type: "undefined" } }),
      async () => new Map([["frame-1", "session:frame"]]),
      "the page-side hit test returned no result",
    ],
  ];
  for (const [name, services, frameSessions, reason] of cases) {
    await assert.rejects(
      () =>
        clickPointInPage(
          services,
          "session:page",
          140,
          250,
          {},
          0,
          0,
          frameSessions,
        ),
      assertUncheckedRefusal("page.mouse.click", reason),
      name,
    );
    assert.equal(
      services.calls.some(([method]) => method === "Input.dispatchMouseEvent"),
      false,
      `${name}: no pointer input reaches the page`,
    );
  }
});

test("Page mouse click presses on an iframe element that has no content frame", async () => {
  const services = crossOriginFrameServices(
    selectVerdict(DROPDOWN),
    answer("DOM.describeNode", { node: { nodeName: "IFRAME" } }),
  );
  await clickPointInPage(services, "session:page", 140, 250);
  assert.equal(pressCount(services.calls), 1);
  assert.equal(frameEvaluations(services.calls).length, 0);
});

test("Page mouse presses fail closed when the hit test gives no positive answer", async () => {
  const responses = [
    ["an exception", { exceptionDetails: { text: "Uncaught" }, result: {} }],
    ["an error object", { result: { type: "object", subtype: "error" } }],
    ["an undefined value", { result: { type: "undefined" } }],
    ["no result", {}],
    ["no response", null],
    ["a non-JSON string", { result: { value: "nope" } }],
    ["a JSON non-object", { result: { value: "null" } }],
    ["an object without a verdict", { result: { value: "{}" } }],
    [
      "a malformed select description",
      { result: { value: JSON.stringify({ nativeSelect: { locator: 1 } }) } },
    ],
    [
      "frames nested too deeply",
      { result: { value: '{"unchecked":"too deep"}' } },
    ],
  ];
  for (const [name, response] of responses) {
    const respond = answer("Runtime.evaluate", response);
    const click = pointServices(null, respond);
    await assert.rejects(
      () => clickPointInPage(click, "session:page", 40, 50),
      assertUncheckedRefusal("page.mouse.click"),
      name,
    );
    assert.equal(
      click.calls.some(([method]) => method === "Input.dispatchMouseEvent"),
      false,
      `${name}: no pointer input reaches the page`,
    );

    const down = pointServices(null, respond);
    await assert.rejects(
      () => mouseButtonInPage(down, "session:page", "mousePressed", 40, 50, 1),
      assertUncheckedRefusal("page.mouse.down"),
      name,
    );
    assert.equal(pressCount(down.calls), 0, name);
  }

  const rejected = pointServices(null, (method) => {
    if (method === "Runtime.evaluate") throw new Error("Session closed");
  });
  await assert.rejects(
    () => clickPointInPage(rejected, "session:page", 40, 50),
    assertUncheckedRefusal("page.mouse.click", "Session closed"),
  );
  assert.equal(pressCount(rejected.calls), 0);
});

test("Page click fails closed when the native select check returns no result", async () => {
  for (const value of [undefined, null, {}, "ok"]) {
    const services = topLevelClickServices({ respond: () => value });
    await assert.rejects(
      () => clickInPage(services, "session:page", new RefMap(), "#button"),
      assertUncheckedRefusal(
        "page.click",
        "the page-side hit test returned no result",
      ),
    );
    assert.equal(pressCount(services.calls), 0);
  }

  // A right press opens no select menu, so it keeps the previous behavior.
  const right = topLevelClickServices({ respond: () => undefined });
  await clickInPage(right, "session:page", new RefMap(), "#button", {
    button: "right",
  });
  assert.equal(pressCount(right.calls), 1);
});
