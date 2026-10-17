import test from "node:test";
import assert from "node:assert/strict";

import { setOverrides } from "../../dist/src/state.js";
import { pressKey } from "../../dist/src/driver/keyboard.js";

test("pressKey emits the macOS paste shortcut as a native editing sequence", async () => {
  const calls = [];
  const restore = setOverrides({
    platform: "darwin",
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await pressKey("V", 4);
  } finally {
    restore();
  }

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], {
    method: "Input.dispatchKeyEvent",
    sessionId: undefined,
    params: {
      type: "rawKeyDown",
      key: "Meta",
      code: "MetaLeft",
      modifiers: 4,
      windowsVirtualKeyCode: 91,
      location: 1,
    },
  });
  assert.deepEqual(calls[1].params, {
    type: "rawKeyDown",
    key: "V",
    code: "KeyV",
    modifiers: 4,
    windowsVirtualKeyCode: 86,
    commands: ["paste"],
  });
  assert.deepEqual(calls[2].params, {
    type: "keyUp",
    key: "V",
    code: "KeyV",
    modifiers: 4,
    windowsVirtualKeyCode: 86,
  });
  assert.deepEqual(calls[3].params, {
    type: "keyUp",
    key: "Meta",
    code: "MetaLeft",
    modifiers: 0,
    windowsVirtualKeyCode: 91,
    location: 1,
  });
});

test("pressKey maps Command+A to the selectAll editing command", async () => {
  const calls = [];
  const restore = setOverrides({
    platform: "darwin",
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await pressKey("a", 4);
  } finally {
    restore();
  }

  assert.deepEqual(calls[1].params.commands, ["selectAll"]);
});

test("pressKey maps Control+A to the selectAll editing command", async () => {
  const calls = [];
  const restore = setOverrides({
    platform: "linux",
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await pressKey("a", 2);
  } finally {
    restore();
  }

  assert.deepEqual(calls[1].params.commands, ["selectAll"]);
});

test("pressKey does not map modified Command+A variants to selectAll", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await pressKey("a", 12);
  } finally {
    restore();
  }

  const keyDown = calls.find(
    (call) => call.params.code === "KeyA" && call.params.type === "rawKeyDown",
  );
  assert.equal(keyDown.params.commands, undefined);
});

test("pressKey leaves ordinary printable keys unchanged", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
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
    text: "x",
    unmodifiedText: "x",
  });
  assert.deepEqual(calls[1].params, {
    type: "keyUp",
    key: "x",
    code: "KeyX",
    modifiers: 0,
    windowsVirtualKeyCode: 88,
  });
});

test("pressKey maps Backspace and Delete to editing commands", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await pressKey("Backspace");
    await pressKey("Delete");
  } finally {
    restore();
  }

  assert.deepEqual(calls[0].params.commands, ["deleteBackward"]);
  assert.deepEqual(calls[2].params.commands, ["deleteForward"]);
  assert.equal(calls[0].params.type, "rawKeyDown");
  assert.equal(calls[2].params.type, "rawKeyDown");
});

test("pressKey does not synthesize a successful paste when native input is absent", async () => {
  const originalEgo = globalThis.ego;
  globalThis.ego = { sendCDPMessage: () => {} };
  let evaluateCallCount = 0;
  const restore = setOverrides({
    platform: "darwin",
    cdpOverride(method) {
      if (method === "Runtime.evaluate") {
        evaluateCallCount++;
        if (evaluateCallCount === 1) {
          return { result: { value: true } };
        }
        return { result: { value: { seen: false, fallback: false } } };
      }
      return {};
    },
  });
  try {
    await assert.rejects(
      pressKey("V", 4),
      /could not deliver native editing shortcut/i,
    );
  } finally {
    restore();
    if (originalEgo === undefined) delete globalThis.ego;
    else globalThis.ego = originalEgo;
  }
});

test("pressKey triggers probe fallback when CDP dispatch is not trusted", async () => {
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
    await pressKey("a");
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

test("pressKey skips probe fallback when CDP dispatch is trusted", async () => {
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
    await pressKey("x");
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
