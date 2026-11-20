import test from "node:test";
import assert from "node:assert/strict";

import { clickInPage } from "../dist/src/driver/page-actions.js";
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

  for (const check of pageCalls(services.calls)) {
    assert.match(check, /isActionTargetDisabled\(this\)/);
    assert.doesNotMatch(check, /elementsFromPoint/);
  }
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
