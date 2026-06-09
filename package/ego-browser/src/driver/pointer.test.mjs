import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { click, scroll } from "../../dist/src/driver/pointer.js";

test("click resolves selector offsets without the public elementEval helper", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate" && params.objectGroup === "ego-browser") {
        return { result: { objectId: "object-1" } };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { x: 125, y: 225 } } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: { x: 100, y: 200 } } };
      }
      return {};
    }
  });
  try {
    await click({ selector: "#target", x: 12, y: 8 });
  } finally {
    restore();
  }

  const callFunction = calls.find((call) => call.method === "Runtime.callFunctionOn");
  assert.equal(callFunction.params.objectId, "object-1");
  assert.match(callFunction.params.functionDeclaration, /getBoundingClientRect/);

  assert.ok(calls.some((call) => call.method === "Runtime.releaseObject" && call.params.objectId === "object-1"));

  const mouseEvents = calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.deepEqual(mouseEvents.map((call) => ({
    type: call.params.type,
    x: call.params.x,
    y: call.params.y
  })), [
    { type: "mousePressed", x: 112, y: 208 },
    { type: "mouseReleased", x: 112, y: 208 }
  ]);
});

test("scroll falls back to DOM scrolling when mouseWheel dispatch fails", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Input.dispatchMouseEvent") {
        throw new Error("CDP request timed out: Input.dispatchMouseEvent");
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { x: 0, y: 450 } } };
      }
      return {};
    }
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
    deltaY: 450
  });
  assert.equal(calls[1].method, "Runtime.evaluate");
  assert.match(calls[1].params.expression, /window\.scrollBy/);
});
