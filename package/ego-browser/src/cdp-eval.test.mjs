import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import { cdp, hasReturnStatement, js } from "../dist/src/cdp-eval.js";
import { setOverrides } from "../dist/src/state.js";

async function withRecordedCdp(run) {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      return {};
    },
  });
  try {
    await run(calls);
  } finally {
    restore();
  }
}

test("cdp rejects a sessionId inside params instead of running in the page session", async () => {
  await withRecordedCdp(async (calls) => {
    await assert.rejects(
      () => cdp("Runtime.evaluate", { expression: "1", sessionId: "s1" }),
      (error) => {
        assert(error instanceof TypeError);
        assert.match(error.message, /Runtime\.evaluate/);
        assert.match(error.message, /cdp\(method, params, sessionId\)/);
        return true;
      },
    );
    assert.deepEqual(calls, [], "the command must never reach the browser");
  });
});

test("cdp routes a sessionId passed as the third argument", async () => {
  await withRecordedCdp(async (calls) => {
    await cdp("Runtime.evaluate", { expression: "1" }, "s1");
    assert.deepEqual(calls, [
      {
        method: "Runtime.evaluate",
        params: { expression: "1" },
        sessionId: "s1",
      },
    ]);
  });
});

test("cdp keeps Target commands whose protocol params define sessionId", async () => {
  await withRecordedCdp(async (calls) => {
    await cdp("Target.detachFromTarget", { sessionId: "s1" });
    await cdp("Target.sendMessageToTarget", { sessionId: "s1", message: "{}" });
    assert.deepEqual(
      calls.map(({ method, params, sessionId }) => [
        method,
        params.sessionId,
        sessionId,
      ]),
      [
        ["Target.detachFromTarget", "s1", undefined],
        ["Target.sendMessageToTarget", "s1", undefined],
      ],
    );
  });
});

test("hasReturnStatement ignores returns inside nested functions", () => {
  for (const expression of [
    "[1, 2].map(x => { return x * 2; })",
    "function f() { return 1; } f()",
    "const f = function () { return 1; }; f()",
    "({ value() { return 1; } }).value()",
    "class C { value() { return 1; } } new C().value()",
    "`${(() => { return 1; })()}`",
    "(async () => { return 1; })()",
  ]) {
    assert.equal(hasReturnStatement(expression), false, expression);
  }
});

test("hasReturnStatement finds outer returns inside control flow", () => {
  for (const expression of [
    "return 1",
    "if (true) { return 1; }",
    "try { throw 1; } catch (error) { return error; }",
    "for (const n of [1]) { return n; }",
    "const f = () => { return 1; }; return f();",
    "(1 + 2); return 4;",
  ]) {
    assert.equal(hasReturnStatement(expression), true, expression);
  }
});

test("hasReturnStatement ignores return in regexes, strings, and identifiers", () => {
  for (const expression of [
    "/return/i.test('return')",
    "'return 1'",
    "// return 1\n2",
    "({ return: 1 }).return",
    "const returnCode = 1; returnCode",
    "const $return = 1; $return",
  ]) {
    assert.equal(hasReturnStatement(expression), false, expression);
  }
});

test("hasReturnStatement leaves invalid source for the browser to reject", () => {
  assert.equal(hasReturnStatement("return ("), false);
});

// Execute the emitted expression for real so a wrapper that drops the value
// cannot pass by way of a mock that answers unconditionally.
async function evaluateInVm(expression) {
  let emitted;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      assert.equal(method, "Runtime.evaluate");
      emitted = params.expression;
      const value = await runInNewContext(params.expression);
      return {
        result:
          value === undefined
            ? { type: "undefined" }
            : { type: typeof value, value: structuredClone(value) },
      };
    },
  });
  try {
    return { value: await js(expression), emitted };
  } finally {
    restore();
  }
}

for (const [name, expression, expected] of [
  ["arrow callback", "[1, 2].map(x => { return x * 2; })", [2, 4]],
  ["function declaration", "function f() { return 3; } f()", 3],
  ["object method", "[1].map(({ value() { return 4; } }).value)", [4]],
  ["class method", "class C { value() { return 5; } } new C().value()", 5],
  ["regex literal", "/return/i.test('RETURN')", true],
  ["outer return", "return 42", 42],
  ["block return", "if (true) { return [2, 4]; }", [2, 4]],
  ["return after a parenthesized expression", "(1 + 2); return 4;", 4],
  ["return with a trailing line comment", "return 6 // done", 6],
  ["return after await", "const n = await Promise.resolve(7); return n;", 7],
]) {
  test(`js preserves the result of ${name}`, async () => {
    const { value } = await evaluateInVm(expression);
    assert.deepEqual(value, expected);
  });
}

test("js sends expressions without an outer return unchanged", async () => {
  const expression = "(async () => { return 1; })()";
  const { emitted } = await evaluateInVm(expression);
  assert.equal(emitted, expression);
});
