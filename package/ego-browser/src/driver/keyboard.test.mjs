import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import {
  check,
  down,
  focus,
  press,
  pressOnSelector,
  pressSequentially,
  selectOption,
  setChecked,
  typeText,
  uncheck,
  up,
} from "../../dist/src/driver/keyboard.js";

test("press maps Command+A to the selectAll editing command", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await press("Meta+a");
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
      commands: ["selectAll"],
    },
  });
  assert.deepEqual(calls[1].params, {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 4,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
});

test("press maps Control+A to the selectAll editing command", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await press("Control+a");
  } finally {
    restore();
  }

  assert.deepEqual(calls[0].params.commands, ["selectAll"]);
});

test("press does not map modified Command+A variants to selectAll", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await press("Shift+Meta+a");
  } finally {
    restore();
  }

  assert.equal(calls[0].params.commands, undefined);
});

test("down and up hold modifier state for subsequent presses", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await down("Shift");
    await press("ArrowLeft");
    await up("Shift");
  } finally {
    restore();
  }

  const keyEvents = calls.filter(
    (entry) => entry.method === "Input.dispatchKeyEvent",
  );
  assert.deepEqual(
    keyEvents.map((entry) => [
      entry.params.type,
      entry.params.key,
      entry.params.modifiers,
    ]),
    [
      ["keyDown", "Shift", 8],
      ["keyDown", "ArrowLeft", 8],
      ["keyUp", "ArrowLeft", 8],
      ["keyUp", "Shift", 8],
    ],
  );
});

test("press parses a literal plus key with modifiers (Shift++)", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await press("Shift++");
  } finally {
    restore();
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, {
    type: "keyDown",
    key: "+",
    code: "+",
    modifiers: 8,
    windowsVirtualKeyCode: 43,
    nativeVirtualKeyCode: 43,
    text: "+",
    unmodifiedText: "+",
  });
  assert.deepEqual(calls[1].params, {
    type: "keyUp",
    key: "+",
    code: "+",
    modifiers: 8,
    windowsVirtualKeyCode: 43,
    nativeVirtualKeyCode: 43,
  });
});

test("press leaves ordinary printable keys unchanged", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await press("x");
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
    unmodifiedText: "x",
  });
  assert.deepEqual(calls[1].params, {
    type: "keyUp",
    key: "x",
    code: "KeyX",
    modifiers: 0,
    windowsVirtualKeyCode: 88,
    nativeVirtualKeyCode: 88,
  });
});

test("press maps Backspace and Delete to editing commands", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await press("Backspace");
    await press("Delete");
  } finally {
    restore();
  }

  assert.deepEqual(calls[0].params.commands, ["deleteBackward"]);
  assert.deepEqual(calls[2].params.commands, ["deleteForward"]);
});

test("press triggers probe fallback when CDP dispatch is not trusted", async () => {
  // Enable canProbeInputFallback() by providing ego runtime
  const originalEgo = globalThis.ego;
  globalThis.ego = { sendCDPMessage: () => {} };
  let evaluateCallCount = 0;
  const evaluateExpressions = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      if (method === "Runtime.evaluate") {
        evaluateCallCount++;
        evaluateExpressions.push(params.expression);
        // First call: installKeyProbe — return truthy to indicate probe installed
        if (evaluateCallCount === 1) {
          return { result: { value: true } };
        }
        // Second call: finishKeyProbe — simulate CDP dispatch was NOT seen
        // (the CDP keyDown did not produce a trusted event)
        return { result: { value: { seen: false, fallback: true } } };
      }
      // Input.dispatchKeyEvent calls proceed normally
      return {};
    },
  });
  try {
    await press("a");
  } finally {
    restore();
    if (originalEgo === undefined) delete globalThis.ego;
    else globalThis.ego = originalEgo;
  }

  // Verify probe install and finish were called
  assert.equal(
    evaluateCallCount,
    2,
    "Runtime.evaluate called for install and finish",
  );
  // Install expression should reference __egoBrowserInputProbes
  assert.match(
    evaluateExpressions[0],
    /__egoBrowserInputProbes/,
    "install expression sets up probe",
  );
  // Finish expression should contain the fallback dispatch logic
  assert.match(
    evaluateExpressions[1],
    /dispatchEvent/,
    "finish expression contains fallback dispatch",
  );
  assert.match(
    evaluateExpressions[1],
    /KeyboardEvent/,
    "finish expression dispatches KeyboardEvent in fallback",
  );
});

test("press skips probe fallback when CDP dispatch is trusted", async () => {
  const originalEgo = globalThis.ego;
  globalThis.ego = { sendCDPMessage: () => {} };
  let evaluateCallCount = 0;
  const evaluateExpressions = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      if (method === "Runtime.evaluate") {
        evaluateCallCount++;
        evaluateExpressions.push(params.expression);
        if (evaluateCallCount === 1) {
          return { result: { value: true } };
        }
        // Simulate CDP dispatch WAS seen (trusted event arrived)
        return { result: { value: { seen: true, fallback: false } } };
      }
      return {};
    },
  });
  try {
    await press("x");
  } finally {
    restore();
    if (originalEgo === undefined) delete globalThis.ego;
    else globalThis.ego = originalEgo;
  }

  assert.equal(
    evaluateCallCount,
    2,
    "Runtime.evaluate called for install and finish",
  );
  // When seen=true, finish should return early without dispatching fallback events
  // The expression still contains the fallback code but it returns early via the seen check
  assert.match(
    evaluateExpressions[1],
    /probe\.seen/,
    "finish expression checks probe.seen flag",
  );
});

function selectorCallHarness() {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "object-1" } };
      }
      if (
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration.includes("return selected")
      ) {
        return { result: { value: ["b"] } };
      }
      return {};
    },
  });
  return { calls, restore };
}

test("focus resolves a selector and focuses the element", async () => {
  const { calls, restore } = selectorCallHarness();
  try {
    await focus("#name");
  } finally {
    restore();
  }

  const call = calls.find((entry) => entry.method === "Runtime.callFunctionOn");
  assert.equal(call.params.objectId, "object-1");
  assert.match(call.params.functionDeclaration, /this\.focus\(\)/);
});

// setChecked toggles through a real click, so the harness has to answer the
// whole click path: handle resolution, the visibility gate, the click point,
// and the checked reads that bracket it. `states` is the queue of checked
// values those reads return; the last entry answers every later read.
function checkedStateHarness(states) {
  const calls = [];
  const reads = [];
  const queue = [...states];
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
        return { result: { value: { x: 40, y: 60 } } };
      }
      if (method === "Runtime.callFunctionOn") {
        const source = params.functionDeclaration;
        if (source.includes("setChecked target must be")) {
          reads.push(params.arguments);
          return {
            result: { value: queue.length > 1 ? queue.shift() : queue[0] },
          };
        }
        if (source.includes("checkVisibility")) {
          return { result: { value: true } };
        }
      }
      return {};
    },
  });
  return { calls, reads, restore };
}

test("setChecked toggles a checkbox with a real click, not a property write", async () => {
  const { calls, restore } = checkedStateHarness([false, true]);
  try {
    await setChecked("#agree", true);
  } finally {
    restore();
  }

  assert.deepEqual(
    calls
      .filter((entry) => entry.method === "Input.dispatchMouseEvent")
      .map((entry) => entry.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.ok(
    calls
      .filter((entry) => entry.method === "Runtime.callFunctionOn")
      .every(
        (entry) => !/this\.checked\s*=/.test(entry.params.functionDeclaration),
      ),
    "never assigns the checked property page-side",
  );
});

test("setChecked skips the click when the state already matches", async () => {
  const { calls, restore } = checkedStateHarness([true]);
  try {
    await setChecked("#agree", true);
  } finally {
    restore();
  }

  assert.equal(
    calls.filter((entry) => entry.method === "Input.dispatchMouseEvent").length,
    0,
  );
});

test("setChecked throws when the click leaves the state unchanged", async () => {
  const { restore } = checkedStateHarness([false]);
  try {
    await assert.rejects(
      () => setChecked("#agree", true),
      /did not make it checked/,
    );
  } finally {
    restore();
  }
});

test("check and uncheck request the matching target state", async () => {
  const { reads, restore } = checkedStateHarness([false, true]);
  try {
    await check("#agree");
  } finally {
    restore();
  }
  assert.deepEqual(reads[0], [{ value: true }]);

  const unchecking = checkedStateHarness([true, false]);
  try {
    await uncheck("#agree");
  } finally {
    unchecking.restore();
  }
  assert.deepEqual(unchecking.reads[0], [{ value: false }]);
});

test("selectOption returns selected values", async () => {
  const { calls, restore } = selectorCallHarness();
  try {
    assert.deepEqual(await selectOption("#choice", "b"), ["b"]);
  } finally {
    restore();
  }

  const call = calls.find((entry) => entry.method === "Runtime.callFunctionOn");
  assert.deepEqual(call.params.arguments, [{ value: "b" }]);
  assert.match(call.params.functionDeclaration, /HTMLSelectElement/);
});

test("setChecked rejects page-side validation errors", async () => {
  const restore = setOverrides({
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "object-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: { subtype: "error", description: "Error: wrong target" },
        };
      }
      return {};
    },
  });
  try {
    await assert.rejects(() => setChecked("#text", true), /wrong target/);
  } finally {
    restore();
  }
});

test("pressSequentially focuses a selector then presses characters with delay", async () => {
  const calls = [];
  let now = 0;
  const restore = setOverrides({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "object-1", value: true } };
      }
      return {};
    },
  });
  try {
    await pressSequentially("#name", "ab", { delay: 5 });
  } finally {
    restore();
  }

  const keyDowns = calls.filter(
    (entry) =>
      entry.method === "Input.dispatchKeyEvent" &&
      entry.params.type === "keyDown",
  );
  assert.deepEqual(
    keyDowns.map((entry) => entry.params.key),
    ["a", "b"],
  );
  assert.equal(now, 10);
  assert(
    calls.some(
      (entry) =>
        entry.method === "Runtime.callFunctionOn" &&
        entry.params.functionDeclaration.includes("this.focus()"),
    ),
  );
});

test("typeText presses text without focusing a selector", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await typeText("ab");
  } finally {
    restore();
  }

  const keyDowns = calls.filter(
    (entry) =>
      entry.method === "Input.dispatchKeyEvent" &&
      entry.params.type === "keyDown",
  );
  assert.deepEqual(
    keyDowns.map((entry) => entry.params.key),
    ["a", "b"],
  );
  assert.ok(
    !calls.some((entry) => entry.method === "Runtime.callFunctionOn"),
    "keyboard.type should not focus a selector",
  );
});

test("pressOnSelector focuses a selector then presses a key", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Runtime.evaluate") {
        return { result: { objectId: "object-1", value: true } };
      }
      return {};
    },
  });
  try {
    await pressOnSelector("#name", "Enter");
  } finally {
    restore();
  }

  assert(
    calls.some(
      (entry) =>
        entry.method === "Runtime.callFunctionOn" &&
        entry.params.functionDeclaration.includes("this.focus()"),
    ),
  );
  assert(
    calls.some(
      (entry) =>
        entry.method === "Input.dispatchKeyEvent" &&
        entry.params.type === "keyDown" &&
        entry.params.key === "Enter",
    ),
  );
});
