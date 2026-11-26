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

test("Page click fails closed when a parent-document overlay covers a same-process iframe target", async () => {
  const calls = [];
  const services = {
    async cdp(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Accessibility.getFullAXTree") {
        return params.frameId === "frame-child"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Check" },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId:
              params.backendNodeId === 90 ? "iframe-owner" : "iframe-button",
          },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("frameOwnerReceivesPointer")) {
          return {
            result: {
              value: { error: '<div id="ov"> intercepts pointer events' },
            },
          };
        }
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        // The iframe's own document reports the button as the hit target.
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 90 };
      if (method === "DOM.getBoxModel") {
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };

  await assert.rejects(
    () =>
      clickInPage(
        services,
        "session:page",
        new RefMap(),
        'loc=role:button[name="Check"]',
        {},
        0,
        new Map([["frame-child", "session:page"]]),
      ),
    (error) => {
      assert.equal(error.name, "ElementResolutionError");
      assert.equal(error.kind, "transient");
      assert.equal(
        error.message,
        'page.click failed: <div id="ov"> intercepts pointer events',
      );
      return true;
    },
  );
  const ownerCheck = calls.find(
    ([method, params]) =>
      method === "Runtime.callFunctionOn" &&
      params.functionDeclaration.includes("frameOwnerReceivesPointer"),
  );
  assert.equal(ownerCheck[1].objectId, "iframe-owner");
  assert.equal(ownerCheck[2], "session:page");
  assert.deepEqual(ownerCheck[1].arguments, [
    { value: { x: 10, y: 20 } },
    { value: null },
    { value: null },
  ]);
  assert.equal(
    calls.some(([method]) => method === "Input.dispatchMouseEvent"),
    false,
    "no pointer input reaches the parent overlay",
  );
});

test("Page click parent hit test requires the iframe itself, not an interactive wrapper", async () => {
  let ownerSource;
  const services = {
    async cdp(method, params = {}) {
      if (method === "Accessibility.getFullAXTree") {
        return params.frameId === "frame-child"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Check" },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: `node-${params.backendNodeId}` } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("frameOwnerReceivesPointer")) {
          ownerSource = params.functionDeclaration;
          return { result: { value: { x: 110, y: 220 } } };
        }
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 90 };
      if (method === "DOM.getBoxModel") {
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };
  await clickInPage(
    services,
    "session:page",
    new RefMap(),
    'loc=role:button[name="Check"]',
    {},
    0,
    new Map([["frame-child", "session:page"]]),
  );
  assert.ok(ownerSource, "the parent-document hit test ran");

  // Evaluate the real check against a fake parent document in which the
  // iframe has `pointer-events: none` inside a `role="button"` wrapper.
  const ownerCheck = Function(`return (${ownerSource});`)();
  let hit;
  const document = {
    nodeType: 9,
    elementsFromPoint: () => (hit ? [hit] : []),
    elementFromPoint: () => hit || null,
  };
  const fakeElement = (tagName, attributes, parentElement) => ({
    tagName,
    id: attributes.id || "",
    parentElement,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
    getRootNode: () => document,
  });
  const wrapper = fakeElement("DIV", { id: "wrap", role: "button" }, null);
  const iframe = {
    ...fakeElement("IFRAME", {}, wrapper),
    isConnected: true,
    clientLeft: 0,
    clientTop: 0,
    offsetWidth: 200,
    offsetHeight: 200,
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      width: 200,
      height: 200,
    }),
    ownerDocument: {
      documentElement: fakeElement("HTML", {}, null),
      defaultView: {
        innerWidth: 800,
        innerHeight: 600,
        getComputedStyle: () => ({ paddingLeft: "0", paddingTop: "0" }),
      },
    },
  };

  hit = wrapper;
  assert.deepEqual(ownerCheck.call(iframe, { x: 10, y: 20 }), {
    error: '<div id="wrap" role="button"> intercepts pointer events',
  });
  hit = iframe;
  assert.deepEqual(ownerCheck.call(iframe, { x: 10, y: 20 }), {
    x: 110,
    y: 220,
  });
});

test("Page click parent hit test maps the point through a rotated iframe", async () => {
  let ownerCall;
  const services = {
    async cdp(method, params = {}) {
      if (method === "Accessibility.getFullAXTree") {
        return params.frameId === "frame-child"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Check" },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: `node-${params.backendNodeId}` } };
      }
      if (method === "DOM.getContentQuads") {
        // A 200x200 iframe rotated 90deg clockwise about its center (200, 300).
        return params.objectId === "node-90"
          ? { quads: [[300, 200, 300, 400, 100, 400, 100, 200]] }
          : { quads: [] };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("frameOwnerReceivesPointer")) {
          ownerCall = params;
          return { result: { value: { x: 280, y: 210 } } };
        }
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 90 };
      if (method === "DOM.getBoxModel") {
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };
  await clickInPage(
    services,
    "session:page",
    new RefMap(),
    'loc=role:button[name="Check"]',
    {},
    0,
    new Map([["frame-child", "session:page"]]),
  );
  assert.ok(ownerCall, "the parent-document hit test ran");
  const quad = [300, 200, 300, 400, 100, 400, 100, 200];
  assert.deepEqual(ownerCall.arguments, [
    { value: { x: 10, y: 20 } },
    { value: quad },
    { value: null },
  ]);

  // Evaluate the real check: only the rotated position of the framed point
  // hits the iframe; the axis-aligned estimate (110, 220) hits the parent.
  const ownerCheck = Function(`return (${ownerCall.functionDeclaration});`)();
  const document = { nodeType: 9 };
  const fakeElement = (tagName, attributes) => ({
    tagName,
    id: attributes.id || "",
    parentElement: null,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
    getRootNode: () => document,
  });
  const body = fakeElement("BODY", { id: "parent" });
  const iframe = {
    ...fakeElement("IFRAME", {}),
    isConnected: true,
    clientLeft: 0,
    clientTop: 0,
    offsetWidth: 200,
    offsetHeight: 200,
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      width: 200,
      height: 200,
    }),
    ownerDocument: {
      documentElement: fakeElement("HTML", {}),
      defaultView: {
        innerWidth: 800,
        innerHeight: 600,
        getComputedStyle: () => ({ paddingLeft: "0", paddingTop: "0" }),
      },
    },
  };
  const hitAt = (x, y) =>
    Math.abs(x - 280) < 1e-9 && Math.abs(y - 210) < 1e-9 ? iframe : body;
  document.elementFromPoint = hitAt;
  document.elementsFromPoint = (x, y) => [hitAt(x, y)];

  assert.deepEqual(ownerCheck.call(iframe, { x: 10, y: 20 }, quad), {
    x: 280,
    y: 210,
  });
  // A quad reported relative to an ancestor viewport is realigned with the
  // iframe's own document through its bounding box.
  assert.deepEqual(
    ownerCheck.call(
      iframe,
      { x: 10, y: 20 },
      quad.map((value) => value + 50),
    ),
    { x: 280, y: 210 },
  );
  assert.deepEqual(ownerCheck.call(iframe, { x: 10, y: 20 }, null), {
    error: '<body id="parent"> intercepts pointer events',
  });
});

test("Page click hit-tests every ancestor document of a nested OOPIF target", async () => {
  const ownerChecks = [];
  const services = {
    async cdp(method, params = {}, sessionId) {
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
      if (method === "DOM.getFrameOwner") {
        return { backendNodeId: params.frameId === "frame-map" ? 90 : 91 };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: `node-${params.backendNodeId}` } };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("frameOwnerReceivesPointer")) {
          ownerChecks.push([
            params.objectId,
            sessionId,
            params.arguments[0].value,
          ]);
          return {
            result: {
              value:
                params.objectId === "node-90"
                  ? { x: 110, y: 220 }
                  : {
                      error:
                        '<div class="layui-layer-shade"> intercepts pointer events',
                    },
            },
          };
        }
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      return {};
    },
    async showAgentMousePosition() {},
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

  await assert.rejects(
    () =>
      clickInPage(
        services,
        "session:page",
        new RefMap(),
        'loc=role:button[name="Run nested OOPIF action"]',
        {},
        0,
        iframeSessions,
      ),
    /page\.click failed: <div class="layui-layer-shade"> intercepts pointer events/,
  );
  assert.deepEqual(ownerChecks, [
    ["node-90", "session:runner", { x: 10, y: 20 }],
    ["node-91", "session:page", { x: 110, y: 220 }],
  ]);
});

test("Page click parent hit test undoes an ancestor rotation around an untransformed iframe", async () => {
  // The owner document is itself rendered in a frame rotated 90deg clockwise:
  // its viewport point (x, y) is reported at (1000 - y, x + 50).
  const toReported = ([x, y]) => [1000 - y, x + 50];
  const corners = (left, top, width, height) =>
    [
      [left, top],
      [left + width, top],
      [left + width, top + height],
      [left, top + height],
    ].flatMap(toReported);
  const iframeQuad = corners(100, 200, 200, 200);
  const rootQuad = corners(0, 0, 800, 600);
  let ownerCall;
  const services = {
    async cdp(method, params = {}) {
      if (method === "Accessibility.getFullAXTree") {
        return params.frameId === "frame-child"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Check" },
                  backendDOMNodeId: 21,
                },
              ],
            }
          : { nodes: [] };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: `node-${params.backendNodeId}` } };
      }
      if (method === "DOM.getContentQuads") {
        if (params.objectId === "node-90") return { quads: [iframeQuad] };
        if (params.objectId === "owner-root") return { quads: [rootQuad] };
        return { quads: [] };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("frameOwnerDocumentRoot")) {
          return { result: { objectId: "owner-root" } };
        }
        if (params.functionDeclaration.includes("frameOwnerReceivesPointer")) {
          ownerCall = params;
          return { result: { value: { x: 110, y: 220 } } };
        }
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 90 };
      if (method === "DOM.getBoxModel") {
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };
  await clickInPage(
    services,
    "session:page",
    new RefMap(),
    'loc=role:button[name="Check"]',
    {},
    0,
    new Map([["frame-child", "session:page"]]),
  );
  assert.deepEqual(ownerCall.arguments, [
    { value: { x: 10, y: 20 } },
    { value: iframeQuad },
    { value: rootQuad },
  ]);

  // Only the iframe's untransformed position (110, 220) hits it; aligning the
  // rotated quad's bounding box with the iframe's rect would test (280, 210).
  const ownerCheck = Function(`return (${ownerCall.functionDeclaration});`)();
  const document = { nodeType: 9 };
  const fakeElement = (tagName, attributes) => ({
    tagName,
    id: attributes.id || "",
    parentElement: null,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
    getRootNode: () => document,
  });
  const body = fakeElement("BODY", { id: "parent" });
  const iframe = {
    ...fakeElement("IFRAME", {}),
    isConnected: true,
    clientLeft: 0,
    clientTop: 0,
    offsetWidth: 200,
    offsetHeight: 200,
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      width: 200,
      height: 200,
    }),
    ownerDocument: {
      documentElement: {
        ...fakeElement("HTML", {}),
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 800,
          height: 600,
        }),
      },
      defaultView: {
        innerWidth: 800,
        innerHeight: 600,
        getComputedStyle: () => ({ paddingLeft: "0", paddingTop: "0" }),
      },
    },
  };
  const hitAt = (x, y) =>
    Math.abs(x - 110) < 1e-9 && Math.abs(y - 220) < 1e-9 ? iframe : body;
  document.elementFromPoint = hitAt;
  document.elementsFromPoint = (x, y) => [hitAt(x, y)];

  const mapped = ownerCheck.call(
    iframe,
    { x: 10, y: 20 },
    iframeQuad,
    rootQuad,
  );
  assert.ok(Math.abs(mapped.x - 110) < 1e-9, JSON.stringify(mapped));
  assert.ok(Math.abs(mapped.y - 220) < 1e-9, JSON.stringify(mapped));
  assert.deepEqual(
    ownerCheck.call(iframe, { x: 10, y: 20 }, iframeQuad, null),
    { error: '<body id="parent"> intercepts pointer events' },
  );
});

test("Page click rechecks parent documents after hovering an OOPIF target", async () => {
  const calls = [];
  let ownerChecks = 0;
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
      if (method === "DOM.resolveNode") {
        return {
          object: {
            objectId:
              params.backendNodeId === 90 ? "iframe-owner" : "iframe-button",
          },
        };
      }
      if (method === "Runtime.callFunctionOn") {
        if (params.functionDeclaration.includes("frameOwnerReceivesPointer")) {
          ownerChecks += 1;
          // Hovering the target opens a parent-document overlay.
          return {
            result: {
              value:
                ownerChecks === 1
                  ? { x: 110, y: 220 }
                  : { error: '<div id="ov"> intercepts pointer events' },
            },
          };
        }
        if (params.functionDeclaration.includes("actionable: false")) {
          return { result: { value: { actionable: true } } };
        }
        return params.functionDeclaration.includes("getBoundingClientRect")
          ? { result: { value: { x: 10, y: 20 } } }
          : { result: { value: { ok: true } } };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 90 };
      if (method === "DOM.getBoxModel") {
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };

  await assert.rejects(
    () =>
      clickInPage(
        services,
        "session:page",
        new RefMap(),
        'loc=role:button[name="Run OOPIF action"]',
        {},
        0,
        new Map([["frame-child", "session:frame"]]),
      ),
    /page\.click failed: <div id="ov"> intercepts pointer events/,
  );
  assert.equal(ownerChecks, 2);
  const pointerEvents = calls
    .filter(([method]) => method === "Input.dispatchMouseEvent")
    .map(([, params]) => params.type);
  assert.deepEqual(
    pointerEvents,
    ["mouseMoved"],
    "no press reaches the overlay",
  );
});

test("Page click force skips the parent-document hit test of an iframe target", async () => {
  const calls = [];
  const services = {
    async cdp(method, params = {}, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Accessibility.getFullAXTree") {
        return params.frameId === "frame-child"
          ? {
              nodes: [
                {
                  role: { value: "button" },
                  name: { value: "Check" },
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
      if (method === "DOM.getFrameOwner") return { backendNodeId: 90 };
      if (method === "DOM.getBoxModel") {
        return {
          model: { content: [100, 200, 300, 200, 300, 400, 100, 400] },
        };
      }
      return {};
    },
    async showAgentMousePosition() {},
    async showAgentTaskState() {},
    async sleep() {},
  };

  await clickInPage(
    services,
    "session:page",
    new RefMap(),
    'loc=role:button[name="Check"]',
    { force: true },
    0,
    new Map([["frame-child", "session:page"]]),
  );

  assert.equal(
    calls.some(
      ([method, params]) =>
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("frameOwnerReceivesPointer"),
    ),
    false,
  );
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
