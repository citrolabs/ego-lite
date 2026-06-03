import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { pressKey } from "../../dist/src/driver/keyboard.js";

test("pressKey maps Command+A to the selectAll editing command", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    }
  });
  try {
    await pressKey("a", 4);
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    method: "Input.dispatchKeyEvent",
    sessionId: undefined,
    params: {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      text: "a",
      unmodifiedText: "a",
      commands: ["selectAll"]
    }
  });
  assert.deepEqual(calls[1].params, {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65
  });
});

test("pressKey maps Control+A to the selectAll editing command", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    }
  });
  try {
    await pressKey("a", 2);
  } finally {
    restore();
  }

  assert.deepEqual(calls[0].params.commands, ["selectAll"]);
});

test("pressKey does not map modified Command+A variants to selectAll", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    }
  });
  try {
    await pressKey("a", 12);
  } finally {
    restore();
  }

  assert.equal(calls[0].params.commands, undefined);
});

test("pressKey leaves ordinary printable keys unchanged", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    }
  });
  try {
    await pressKey("x");
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, {
    type: "keyDown",
    key: "x",
    code: "KeyX",
    modifiers: 0,
    windowsVirtualKeyCode: 88,
    nativeVirtualKeyCode: 88,
    text: "x",
    unmodifiedText: "x"
  });
  assert.deepEqual(calls[1].params, {
    type: "keyUp",
    key: "x",
    code: "KeyX",
    modifiers: 0,
    windowsVirtualKeyCode: 88,
    nativeVirtualKeyCode: 88
  });
});
