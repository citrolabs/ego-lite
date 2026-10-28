// Turns one agent program into a REPL cell whose result comes back as a single
// marked line, while top-level declarations keep living in the REPL context.
//
// The browser REPL is Node's own REPL, so a bare `const x = 1` persists across
// cells. Wrapping the program in an async function (needed to capture its
// result, errors, logs and deadline) would make those declarations local, so
// the program is rewritten first, the way Node's REPL handles top-level await:
//
//   const page = task.page("p1");   →   var page;          (outside the wrapper)
//                                        void (page = task.page("p1"));
//   function helper() {}            →   kept; `globalThis.helper = helper;` prepended
//   class Model {}                  →   var Model; Model = class Model {};
//   last expression statement       →   return (expression);
//
// Nested declarations are untouched. Programs are parsed with acorn before
// anything is sent, so a syntax error is reported with the user's line numbers
// and never reaches the REPL (which would print "Uncaught SyntaxError" and
// leave the cell half-consumed).
import { parse, type Node } from "acorn";

import { ErrorCodes, ProtocolError } from "./protocol.js";

export const RESULT_MARKER = "@@EGO-RUN:";

type AnyNode = Node & Record<string, any>;

export type RewrittenProgram = {
  /** Identifiers that must be declared with `var` in the REPL scope. */
  hoisted: string[];
  /** The program body to place inside the async wrapper. */
  body: string;
};

/** Lines that the CLI's cell reader treats as commands; a program must not contain them. */
const CELL_COMMANDS = new Set([".cell", ".end", ".cancel", ".exit"]);

export function rewriteProgram(source: string): RewrittenProgram {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (CELL_COMMANDS.has(line.trim())) {
      throw new ProtocolError(
        ErrorCodes.PROGRAM_SYNTAX,
        `line ${index + 1} is "${line.trim()}", which the REPL reads as a command; move it off its own line`,
      );
    }
  }
  let program: AnyNode;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    }) as AnyNode;
  } catch (error) {
    throw syntaxError(source, error);
  }

  const hoisted: string[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  const prelude: string[] = [];
  const body: AnyNode[] = program.body;

  body.forEach((node, index) => {
    const last = index === body.length - 1;
    switch (node.type) {
      case "VariableDeclaration": {
        const parts: string[] = [];
        for (const declarator of node.declarations) {
          const names = patternNames(declarator.id);
          hoisted.push(...names);
          const target = source.slice(declarator.id.start, declarator.id.end);
          const init = declarator.init
            ? source.slice(declarator.init.start, declarator.init.end)
            : "undefined";
          parts.push(`(${target} = ${init})`);
        }
        edits.push({
          start: node.start,
          end: node.end,
          text: `void (${parts.join(", ")});`,
        });
        break;
      }
      case "FunctionDeclaration": {
        if (node.id?.name) {
          prelude.push(
            `globalThis[${JSON.stringify(node.id.name)}] = ${node.id.name};`,
          );
        }
        break;
      }
      case "ClassDeclaration": {
        const name = node.id?.name;
        if (name) {
          hoisted.push(name);
          edits.push({
            start: node.start,
            end: node.start + "class".length,
            text: `${name} = class`,
          });
          edits.push({ start: node.end, end: node.end, text: ";" });
        }
        break;
      }
      case "ExpressionStatement": {
        // A lone string literal is a "directive" to the parser but a value to
        // the agent (`"done"` as the last line); only "use strict" is kept.
        if (last && node.directive !== "use strict") {
          const expression = source.slice(
            node.expression.start,
            node.expression.end,
          );
          edits.push({
            start: node.start,
            end: node.end,
            text: `return (${expression});`,
          });
        }
        break;
      }
      default:
        break;
    }
  });

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let rewritten = source;
  for (const edit of edits) {
    rewritten =
      rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  return {
    hoisted: [...new Set(hoisted)],
    body: prelude.length ? `${prelude.join("\n")}\n${rewritten}` : rewritten,
  };
}

function patternNames(pattern: AnyNode, out: string[] = []): string[] {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        patternNames(
          property.type === "RestElement" ? property.argument : property.value,
          out,
        );
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element) patternNames(element, out);
      }
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
}

function syntaxError(source: string, error: unknown): ProtocolError {
  const loc = (error as { loc?: { line: number; column: number } })?.loc;
  const message =
    error instanceof Error
      ? error.message.replace(/\s*\(\d+:\d+\)$/, "")
      : String(error);
  if (!loc) {
    return new ProtocolError(
      ErrorCodes.PROGRAM_SYNTAX,
      `program syntax error: ${message}`,
    );
  }
  const line = source.split(/\r?\n/)[loc.line - 1] ?? "";
  const pointer = `${" ".repeat(String(loc.line).length + 3 + loc.column)}^`;
  return new ProtocolError(
    ErrorCodes.PROGRAM_SYNTAX,
    `program syntax error at line ${loc.line}, column ${loc.column + 1}: ${message}\n${loc.line} | ${line}\n${pointer}`,
  );
}

export type WrapOptions = {
  requestId: string;
  timeoutMs: number;
  /** Directory for results above `inlineLimit`; the runtime writes the file itself. */
  spillDir: string;
  inlineLimit: number;
};

/**
 * Build the cell text sent between `.cell` and `.end`. The wrapper:
 * - declares the hoisted names with `var` at REPL scope,
 * - runs the body inside an async function raced against the deadline,
 * - drains the SDK output sink (console.*, cliLog, help(), page notices) through
 *   `globalThis.__egoBrowserFlushRound` when the SDK provides it, otherwise
 *   captures `console.*` directly,
 * - writes exactly one `RESULT_MARKER<requestId>:<json>` line to stdout, which
 *   the CLI's output poll forwards; nothing is left for the REPL to echo.
 */
export function wrapProgram(
  program: RewrittenProgram,
  options: WrapOptions,
): string {
  const header = program.hoisted.length
    ? `var ${program.hoisted.join(", ")};\n`
    : "";
  const marker = JSON.stringify(`${RESULT_MARKER}${options.requestId}:`);
  return `${header}await (async () => {
  const __ego = { t0: performance.now(), timeoutMs: ${options.timeoutMs}, spillDir: ${JSON.stringify(options.spillDir)}, inlineLimit: ${options.inlineLimit}, logs: [] };
  const __exit = process.exit, __console = globalThis.console, __flush = globalThis.__egoBrowserFlushRound;
  const __sink = { write: (chunk) => { __ego.logs.push(String(chunk)); return true; } };
  process.exit = () => { throw Object.assign(new Error("process.exit() is not available inside ego-run; let the program end instead"), { code: "EGO_RUN_NO_EXIT" }); };
  if (typeof __flush !== "function") {
    const capture = (prefix) => (...args) => __ego.logs.push(prefix + args.map((a) => typeof a === "string" ? a : __egoRunInspect(a)).join(" ") + "\\n");
    globalThis.console = { ...__console, log: capture(""), info: capture(""), warn: capture("[warn] "), error: capture("[error] ") };
  }
  let __timer, __result;
  try {
    if (typeof globalThis.__egoBeginProgram === "function") globalThis.__egoBeginProgram();
    const value = await Promise.race([
      (async () => {
${program.body}
      })(),
      new Promise((_, reject) => { __timer = setTimeout(() => reject(Object.assign(new Error("EGO_RUN_DEADLINE: the program ran longer than " + __ego.timeoutMs + " ms; the session will be rebuilt"), { code: "EGO_RUN_DEADLINE" })), __ego.timeoutMs); }),
    ]);
    __result = { ok: true, value, ms: performance.now() - __ego.t0 };
  } catch (error) {
    __result = { ok: false, error: { name: String(error?.name ?? "Error"), message: String(error?.message ?? error), stack: typeof error?.stack === "string" ? error.stack : undefined, code: typeof error?.code === "string" ? error.code : undefined }, ms: performance.now() - __ego.t0 };
  } finally {
    clearTimeout(__timer);
    process.exit = __exit;
    globalThis.console = __console;
    try { if (typeof globalThis.__egoEndProgram === "function") await Promise.race([globalThis.__egoEndProgram(), new Promise((resolve) => setTimeout(resolve, 2000))]); } catch {}
    try { if (typeof __flush === "function") __flush(__sink, !__result.ok); } catch (error) { __ego.logs.push("[ego-run] flush failed: " + (error?.message ?? error) + "\\n"); }
    __result.logs = __ego.logs.join("");
    let json;
    try { json = JSON.stringify(__result, __egoRunReplacer()); } catch (error) { __result.value = undefined; __result.error = __result.error ?? { name: "TypeError", message: "result is not serializable: " + (error?.message ?? error) }; json = JSON.stringify(__result, __egoRunReplacer()); }
    if (json.length > __ego.inlineLimit) {
      try {
        const fs = await import("node:fs/promises"), path = await import("node:path");
        await fs.mkdir(__ego.spillDir, { recursive: true });
        const file = path.join(__ego.spillDir, ${JSON.stringify(options.requestId)} + ".json");
        await fs.writeFile(file, JSON.stringify(__result.value, __egoRunReplacer()));
        __result.valueFile = file; __result.valueBytes = json.length; delete __result.value;
        json = JSON.stringify(__result, __egoRunReplacer());
      } catch (error) { __result.value = undefined; __result.error = { name: "Error", message: "result too large and could not be spilled: " + (error?.message ?? error) }; json = JSON.stringify(__result, __egoRunReplacer()); }
    }
    process.stdout.write(${marker} + json + "\\n");
  }
})();
function __egoRunReplacer() {
  const seen = new WeakSet();
  return function (key, value) {
    if (typeof value === "bigint") return value.toString() + "n";
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (typeof value === "symbol") return value.toString();
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      if (typeof value.label === "string" && typeof value.goto === "function") return { "$page": value.label };
      if (typeof value.spaceId !== "undefined" && typeof value.finish === "function") return { "$taskSpace": value.spaceId, name: value.name };
    }
    return value;
  };
}
function __egoRunInspect(value) {
  try { return JSON.stringify(value, __egoRunReplacer()) ?? String(value); } catch { return String(value); }
}
`;
}

export type ResultEnvelope = {
  ok: boolean;
  value?: unknown;
  valueFile?: string;
  valueBytes?: number;
  logs: string;
  error?: { name: string; message: string; stack?: string; code?: string };
  ms: number;
};

/**
 * Find the result line for `requestId` in REPL output. Returns the parsed
 * envelope and the output with that line removed, or null when it has not
 * arrived yet.
 */
export function extractResult(
  output: string,
  requestId: string,
): { envelope: ResultEnvelope; rest: string } | null {
  const prefix = `${RESULT_MARKER}${requestId}:`;
  const start = output.indexOf(prefix);
  if (start === -1) return null;
  const lineEnd = output.indexOf("\n", start);
  if (lineEnd === -1) return null;
  const raw = output.slice(start + prefix.length, lineEnd).replace(/\r$/, "");
  let envelope: ResultEnvelope;
  try {
    envelope = JSON.parse(raw);
  } catch (error) {
    envelope = {
      ok: false,
      logs: "",
      ms: 0,
      error: {
        name: "Error",
        message: `unreadable result line: ${(error as Error).message}`,
      },
    };
  }
  return { envelope, rest: output.slice(0, start) + output.slice(lineEnd + 1) };
}
