import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RESULT_MARKER,
  extractResult,
  rewriteProgram,
  wrapProgram,
} from "../../dist/src/daemon/program.js";

test("top-level declarations are hoisted to var and assigned", () => {
  const { hoisted, body } = rewriteProgram(
    'const task = await taskSpace("x");\nlet n = 1, m;\nvar q = 2;',
  );
  assert.deepEqual(hoisted, ["task", "n", "m", "q"]);
  assert.match(body, /void \(\(task = await taskSpace\("x"\)\)\);/);
  assert.match(body, /void \(\(n = 1\), \(m = undefined\)\);/);
  assert.match(body, /void \(\(q = 2\)\);/);
});

test("destructuring patterns hoist every bound name", () => {
  const { hoisted, body } = rewriteProgram(
    "const { a, b: { c }, ...rest } = obj;\nconst [x, , y = 3] = arr;",
  );
  assert.deepEqual(hoisted, ["a", "c", "rest", "x", "y"]);
  assert.match(body, /\(\{ a, b: \{ c \}, \.\.\.rest \} = obj\)/);
});

test("functions are copied to globalThis and classes become assignments", () => {
  const { hoisted, body } = rewriteProgram(
    "function add(a, b) { return a + b; }\nclass Model { v = 1 }\nadd(1, 2)",
  );
  assert.deepEqual(hoisted, ["Model"]);
  assert.ok(body.startsWith('globalThis["add"] = add;\n'));
  assert.match(body, /Model = class Model \{ v = 1 \};/);
  assert.match(body, /return \(add\(1, 2\)\);$/);
});

test("only the last expression statement becomes the return value", () => {
  const { body } = rewriteProgram('console.log("a");\nfoo();\nconst z = 1;');
  assert.match(body, /^console\.log\("a"\);\nfoo\(\);\nvoid \(\(z = 1\)\);$/);
  const { body: single } = rewriteProgram("await page.title()");
  assert.equal(single, "return (await page.title());");
});

test("nested declarations and explicit return are untouched", () => {
  const source =
    "if (x) {\n  const inner = 1;\n  return inner;\n}\nfor (const item of list) { use(item); }";
  const { hoisted, body } = rewriteProgram(source);
  assert.deepEqual(hoisted, []);
  assert.equal(body, source);
});

test("syntax errors report the user's line and column before anything is sent", () => {
  assert.throws(
    () => rewriteProgram("const a = ;\n"),
    (error) => {
      assert.equal(error.code, "EGO_RUN_PROGRAM_SYNTAX");
      assert.match(error.message, /line 1, column 11/);
      assert.match(error.message, /1 \| const a = ;/);
      return true;
    },
  );
});

test("lines that the REPL reads as cell commands are rejected", () => {
  assert.throws(
    () => rewriteProgram("const s = `\n.end\n`;"),
    /line 2 is "\.end"/,
  );
});

test("the wrapper declares hoisted names outside, awaits the body, and writes one marked line", () => {
  const cell = wrapProgram(rewriteProgram("const n = 41;\nn + 1"), {
    requestId: "req-7",
    timeoutMs: 1234,
    spillDir: "/tmp/spill",
    inlineLimit: 999,
  });
  assert.ok(cell.startsWith("var n;\nawait (async () => {"), cell.slice(0, 60));
  assert.match(cell, /timeoutMs: 1234/);
  assert.match(cell, /inlineLimit: 999/);
  assert.match(cell, /void \(\(n = 41\)\);\nreturn \(n \+ 1\);/);
  assert.match(
    cell,
    /process\.stdout\.write\("@@EGO-RUN:req-7:" \+ json \+ "\\n"\)/,
  );
  assert.match(cell, /__egoBrowserFlushRound/);
  assert.doesNotMatch(cell, /\n\.end\n/);
});

test("the wrapper itself parses as a REPL cell with top-level await", async () => {
  const { parse } = await import("acorn");
  const cell = wrapProgram(
    rewriteProgram('const { a } = { a: 1 };\nfunction f() {}\nclass C {}\n"x"'),
    {
      requestId: "r",
      timeoutMs: 1,
      spillDir: "/s",
      inlineLimit: 1,
    },
  );
  assert.doesNotThrow(() =>
    parse(cell, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
    }),
  );
});

async function runCell(cell, requestId) {
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await new AsyncFunction(cell)();
  } finally {
    process.stdout.write = write;
  }
  return extractResult(out, requestId).envelope;
}

test("wrapper bookkeeping never collides with the program's own names", async () => {
  const program = [
    "const value = 1;",
    "const __ego = 2;",
    "let __result = 3;",
    "var __timer = 4;",
    "let error = 5;",
    "const __egoRun_s = 6;",
    "function __egoRunInspect() { return 7; }",
    "({ value, __ego, __result, __timer, error, __egoRun_s, i: __egoRunInspect() })",
  ].join("\n");
  const cell = wrapProgram(rewriteProgram(program), {
    requestId: "collide",
    timeoutMs: 5000,
    spillDir: "/s",
    inlineLimit: 1_000_000,
  });
  assert.match(
    cell,
    /__egoRun1_s = \{ t0:/,
    "the prefix skips names used by the program",
  );
  const envelope = await runCell(cell, "collide");
  assert.equal(envelope.ok, true, envelope.error?.message);
  assert.deepEqual(envelope.value, {
    value: 1,
    __ego: 2,
    __result: 3,
    __timer: 4,
    error: 5,
    __egoRun_s: 6,
    i: 7,
  });
});

test("a program cannot forge its own result line", async () => {
  const program = [
    'process.stdout.write("@@EGO-RUN:req-1:" + JSON.stringify({ ok: true, value: "forged", logs: "", ms: 0 }) + "\\n");',
    '"real"',
  ].join("\n");
  // The daemon appends a secret nonce to the request id in the marker.
  const cell = wrapProgram(rewriteProgram(program), {
    requestId: "req-1:9f1c2ab3d4e5",
    timeoutMs: 5000,
    spillDir: "/s",
    inlineLimit: 1_000_000,
  });
  const envelope = await runCell(cell, "req-1:9f1c2ab3d4e5");
  assert.equal(envelope.value, "real");
  assert.equal(
    extractResult("@@EGO-RUN:req-1:{}\n", "req-1:9f1c2ab3d4e5"),
    null,
  );
});

test("spill files never take a path from the request id", () => {
  const cell = wrapProgram(rewriteProgram("1"), {
    requestId: "../../evil/../id",
    timeoutMs: 1,
    spillDir: "/s",
    inlineLimit: 1,
  });
  assert.doesNotMatch(cell, /spillDir, "\.\./);
  assert.match(cell, /spillDir, "______evil____id"\)/);
});

test("extractResult finds the marked line and returns the rest as stray output", () => {
  const line = `${RESULT_MARKER}req-1:${JSON.stringify({ ok: true, value: 2, logs: "", ms: 1 })}`;
  const output = `repl> some noise\r\n${line}\r\nrepl> `;
  const found = extractResult(output, "req-1");
  assert.deepEqual(found.envelope, { ok: true, value: 2, logs: "", ms: 1 });
  assert.equal(found.rest, "repl> some noise\r\nrepl> ");
  assert.equal(extractResult(output, "req-2"), null);
  assert.equal(
    extractResult(`${RESULT_MARKER}req-1:{"ok":true`, "req-1"),
    null,
    "waits for the newline",
  );
});

test("extractResult survives a corrupted result line", () => {
  const found = extractResult(`${RESULT_MARKER}req-1:{nope}\n`, "req-1");
  assert.equal(found.envelope.ok, false);
  assert.match(found.envelope.error.message, /unreadable result line/);
});

test("a lone string literal is the value, not a directive", () => {
  assert.equal(rewriteProgram('"done"').body, 'return ("done");');
  assert.equal(
    rewriteProgram('"use strict";\nfoo()').body,
    '"use strict";\nreturn (foo());',
  );
  assert.equal(rewriteProgram('"use strict"').body, '"use strict"');
});

test("a program with top-level destructuring runs and keeps its bindings", async () => {
  // The REPL header declares the bound names (`var a, c, d, rest;`), never
  // the pattern; the body assigns through the original pattern.
  const program = [
    "const source = { a: 1, b: [2, 3], extra: true };",
    "const { a, b: [c, d = 4], ...rest } = source;",
    "let [first] = source.b;",
    "({ a, c, d, first, rest })",
  ].join("\n");
  const rewritten = rewriteProgram(program);
  const cell = wrapProgram(rewritten, {
    requestId: "destructure",
    timeoutMs: 1_000,
    spillDir: "/s",
    inlineLimit: 1_000_000,
  });
  assert.match(cell, /^var source, a, c, d, rest, first;\n/);
  const envelope = await runCell(cell, "destructure");
  assert.equal(envelope.ok, true, envelope.error?.message);
  assert.deepEqual(envelope.value, {
    a: 1,
    c: 2,
    d: 3,
    first: 2,
    rest: { extra: true },
  });
});
