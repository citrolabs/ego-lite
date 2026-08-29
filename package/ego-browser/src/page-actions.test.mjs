import test from "node:test";
import assert from "node:assert/strict";

import { clickInPage } from "../dist/src/driver/page-actions.js";
import { RefMap } from "../dist/src/ref-map.js";

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
