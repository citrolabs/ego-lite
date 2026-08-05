import test from "node:test";
import assert from "node:assert/strict";

import {
  hasReturnStatement,
  decodeUnserializableJsValue,
  runtimeValue,
  evaluate,
  cdp,
} from "../dist/src/cdp-eval.js";
import { setOverrides } from "../dist/src/state.js";

/* ------------------------------------------------------------------ */
/*  hasReturnStatement — the state-machine parser                     */
/* ------------------------------------------------------------------ */

test("hasReturnStatement detects a bare return", () => {
  assert.equal(hasReturnStatement("return 1"), true);
});

test("hasReturnStatement ignores return inside strings and comments", () => {
  assert.equal(hasReturnStatement("'return 1'"), false);
  assert.equal(hasReturnStatement('"return 1"'), false);
  assert.equal(hasReturnStatement("// return 1\n1 + 2"), false);
  assert.equal(hasReturnStatement("/* return 1 */ 1 + 2"), false);
});

test("hasReturnStatement does not match return as part of an identifier", () => {
  assert.equal(hasReturnStatement("const returned = 1; returned + 1"), false);
  assert.equal(hasReturnStatement("const returnCode = 1; returnCode"), false);
});

test("hasReturnStatement ignores return inside a regex literal", () => {
  assert.equal(
    hasReturnStatement("/return/i.test(document.body.innerText)"),
    false,
  );
  assert.equal(
    hasReturnStatement("/no return value/.test(document.title)"),
    false,
  );
  assert.equal(hasReturnStatement("[/return/, /also return/].length"), false);
  assert.equal(hasReturnStatement("/[/]return[/]/.source"), false);
});

test("hasReturnStatement finds a real return past a regex containing a quote", () => {
  assert.equal(hasReturnStatement("if (/'/.test(s)) foo(); return s;"), true);
});

test("hasReturnStatement treats a slash after a value as division, not a regex", () => {
  assert.equal(hasReturnStatement("const rate = total / count; rate"), false);
  assert.equal(hasReturnStatement("a / b / c"), false);
});

/* ------------------------------------------------------------------ */
/*  decodeUnserializableJsValue — special CDP value decoding          */
/* ------------------------------------------------------------------ */

test("decodeUnserializableJsValue decodes NaN", () => {
  assert.ok(Number.isNaN(decodeUnserializableJsValue("NaN")));
});

test("decodeUnserializableJsValue decodes Infinity", () => {
  assert.equal(
    decodeUnserializableJsValue("Infinity"),
    Number.POSITIVE_INFINITY,
  );
});

test("decodeUnserializableJsValue decodes -Infinity", () => {
  assert.equal(
    decodeUnserializableJsValue("-Infinity"),
    Number.NEGATIVE_INFINITY,
  );
});

test("decodeUnserializableJsValue decodes -0 using Object.is", () => {
  const result = decodeUnserializableJsValue("-0");
  assert.ok(Object.is(result, -0), "result must be negative zero");
});

test("decodeUnserializableJsValue decodes BigInt", () => {
  assert.equal(decodeUnserializableJsValue("42n"), 42n);
});

test("decodeUnserializableJsValue decodes large BigInt", () => {
  assert.equal(
    decodeUnserializableJsValue("9007199254740993n"),
    9007199254740993n,
  );
});

test("decodeUnserializableJsValue passes through unknown strings", () => {
  assert.equal(decodeUnserializableJsValue("something"), "something");
});

/* ------------------------------------------------------------------ */
/*  runtimeValue — CDP RemoteObject to JS value conversion            */
/* ------------------------------------------------------------------ */

test("runtimeValue extracts a string value", () => {
  const result = runtimeValue(
    { result: { type: "string", value: "hello" } },
    "'hello'",
  );
  assert.equal(result, "hello");
});

test("runtimeValue extracts a number value", () => {
  const result = runtimeValue({ result: { type: "number", value: 42 } }, "42");
  assert.equal(result, 42);
});

test("runtimeValue extracts a boolean value", () => {
  const result = runtimeValue(
    { result: { type: "boolean", value: true } },
    "true",
  );
  assert.equal(result, true);
});

test("runtimeValue extracts null", () => {
  const result = runtimeValue(
    { result: { type: "object", subtype: "null", value: null } },
    "null",
  );
  assert.equal(result, null);
});

test("runtimeValue extracts undefined when no value key exists", () => {
  const result = runtimeValue({ result: { type: "undefined" } }, "undefined");
  assert.equal(result, null); // falls through to the null default
});

test("runtimeValue decodes unserializable NaN", () => {
  const result = runtimeValue(
    { result: { type: "number", unserializableValue: "NaN" } },
    "NaN",
  );
  assert.ok(Number.isNaN(result));
});

test("runtimeValue decodes unserializable -0", () => {
  const result = runtimeValue(
    { result: { type: "number", unserializableValue: "-0" } },
    "-0",
  );
  assert.ok(Object.is(result, -0));
});

test("runtimeValue throws on exception details", () => {
  assert.throws(
    () =>
      runtimeValue(
        {
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught",
            lineNumber: 0,
            columnNumber: 5,
          },
        },
        "throw new Error()",
      ),
    /JavaScript evaluation failed at line 0, column 5/,
  );
});

test("runtimeValue reports thrown primitive exception values", () => {
  assert.throws(
    () =>
      runtimeValue(
        {
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught",
            exception: { value: "primitive boom" },
          },
        },
        "throw value",
      ),
    /primitive boom/,
  );
});

test("runtimeValue falls back to exception className", () => {
  assert.throws(
    () =>
      runtimeValue(
        {
          result: { type: "object", subtype: "error" },
          exceptionDetails: {
            text: "Uncaught",
            exception: { className: "CustomError" },
          },
        },
        "throw custom",
      ),
    /CustomError/,
  );
});

test("runtimeValue truncates long expressions in error messages", () => {
  const expression = "x".repeat(200);
  const expectedSnippet = `${"x".repeat(157)}...`;
  assert.throws(
    () =>
      runtimeValue(
        {
          result: { type: "object", subtype: "error" },
          exceptionDetails: { text: "Uncaught" },
        },
        expression,
      ),
    (error) => {
      assert.match(
        error.message,
        new RegExp(`expression: ${expectedSnippet}$`),
      );
      assert.doesNotMatch(error.message, new RegExp(`x{158}\\.\\.\\.$`));
      return true;
    },
  );
});

test("runtimeValue throws on result subtype error without exceptionDetails", () => {
  assert.throws(
    () =>
      runtimeValue(
        {
          result: {
            type: "object",
            subtype: "error",
            description: "ReferenceError: x is not defined",
          },
        },
        "x",
      ),
    /JavaScript evaluation failed/,
  );
});

/* ------------------------------------------------------------------ */
/*  cdp() — thin wrapper over state.send                              */
/* ------------------------------------------------------------------ */

test("cdp sends method and params through cdpOverride", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (method, params, sessionId) => {
      calls.push([method, params, sessionId]);
      return { value: "ok" };
    },
  });
  try {
    const result = await cdp("Runtime.evaluate", { expression: "1" });
    assert.equal(result.value, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "Runtime.evaluate");
  } finally {
    restore();
  }
});

test("cdp tracks Network domain state on enable", async () => {
  const restore = setOverrides({
    cdpOverride: async () => ({}),
  });
  try {
    await cdp("Network.enable");
    // networkDomainEnabled is side-effect on state; we just verify no error
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ */
/*  evaluate() — Playwright-style pageFunction evaluation              */
/* ------------------------------------------------------------------ */

test("evaluate auto-wraps string expressions with top-level return", async () => {
  let capturedExpression;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        capturedExpression = params.expression;
        return { result: { type: "number", value: 42 } };
      }
      return {};
    },
  });
  try {
    const result = await evaluate("return 42");
    assert.equal(result, 42);
    assert.equal(capturedExpression, "(function(){return 42})()");
  } finally {
    restore();
  }
});

test("evaluate passes plain expressions without IIFE wrapping", async () => {
  let capturedExpression;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        capturedExpression = params.expression;
        return { result: { type: "number", value: 3 } };
      }
      return {};
    },
  });
  try {
    const result = await evaluate("1 + 2");
    assert.equal(result, 3);
    assert.equal(capturedExpression, "1 + 2");
  } finally {
    restore();
  }
});

test("evaluate does not wrap a regex-literal expression in an IIFE", async () => {
  let capturedExpression;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        capturedExpression = params.expression;
        return { result: { type: "boolean", value: false } };
      }
      return {};
    },
  });
  try {
    const expr = "/return/i.test(document.body.innerText)";
    const result = await evaluate(expr);
    // Must be sent verbatim; wrapping it as (function(){ ... })() would swallow
    // the value and return undefined because the IIFE has no return.
    assert.equal(capturedExpression, expr);
    assert.equal(result, false);
  } finally {
    restore();
  }
});

test("evaluate does not wrap string expressions that already start with paren", async () => {
  let capturedExpression;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        capturedExpression = params.expression;
        return { result: { type: "number", value: 10 } };
      }
      return {};
    },
  });
  try {
    await evaluate("(function(){ return 10 })()");
    assert.equal(capturedExpression, "(function(){ return 10 })()");
  } finally {
    restore();
  }
});

test("evaluate passes function pageFunctions with an arg", async () => {
  let capturedExpression;
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        capturedExpression = params.expression;
        return { result: { type: "string", value: "Hello!" } };
      }
      return {};
    },
  });
  try {
    const result = await evaluate((suffix) => document.title + suffix, "!");
    assert.equal(result, "Hello!");
    assert.match(
      capturedExpression,
      /^\(\(suffix\) => document\.title \+ suffix\)\("!"\)$/,
    );
  } finally {
    restore();
  }
});

test("evaluate rejects non-string/non-function input", async () => {
  await assert.rejects(
    () => evaluate(123),
    /expects a string expression or function pageFunction/,
  );
  await assert.rejects(
    () => evaluate(null),
    /expects a string expression or function pageFunction/,
  );
});

test("evaluate rejects string expressions with non-string args", async () => {
  await assert.rejects(
    () => evaluate("document.title", { suffix: "!" }),
    /string form only accepts a legacy target id/,
  );
});

test("evaluate propagates page exceptions", async () => {
  const restore = setOverrides({
    cdpOverride: async (method, params) => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            subtype: "error",
            description: "ReferenceError: x is not defined",
          },
          exceptionDetails: {
            text: "Uncaught",
            lineNumber: 0,
            columnNumber: 0,
            exception: { description: "ReferenceError: x is not defined" },
          },
        };
      }
      return {};
    },
  });
  try {
    await assert.rejects(() => evaluate("x"), /ReferenceError/);
  } finally {
    restore();
  }
});

test("evaluate attaches to a target session when legacy target id is given", async () => {
  const calls = [];
  const restore = setOverrides({
    cdpOverride: async (method, params, sessionId) => {
      calls.push([method, params, sessionId]);
      if (method === "Target.attachToTarget") {
        return { sessionId: "sess-123" };
      }
      if (method === "Runtime.evaluate") {
        return { result: { type: "string", value: "iframe-result" } };
      }
      return {};
    },
  });
  try {
    const result = await evaluate("return document.title", "target-abc");
    assert.equal(result, "iframe-result");
    assert.deepEqual(calls[0], [
      "Target.attachToTarget",
      { targetId: "target-abc", flatten: true },
      undefined,
    ]);
    assert.equal(calls[1][0], "Runtime.evaluate");
    assert.equal(
      calls[1][1].expression,
      "(function(){return document.title})()",
    );
    assert.equal(calls[1][2], "sess-123");
  } finally {
    restore();
  }
});
