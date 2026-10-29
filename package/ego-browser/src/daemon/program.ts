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
  // Wrapper bookkeeping lives in the same scopes as the rewritten program, so
  // its identifiers must not occur anywhere in the program text (a user
  // `const value` would otherwise be assigned while the wrapper's own binding
  // is in its temporal dead zone).
  const text = `${program.body}\n${program.hoisted.join(" ")}`;
  let P = "__egoRun_";
  for (let i = 1; text.includes(P); i += 1) P = `__egoRun${i}_`;
  // Spill files are named after the id; keep it a plain basename whatever the
  // caller sent (the daemon validates ids, this is the second line).
  const spillBase =
    options.requestId.replace(/[^A-Za-z0-9_-]/g, "_") || "result";
  return `${header}await (async () => {
  const ${P}s = { t0: performance.now(), timeoutMs: ${options.timeoutMs}, spillDir: ${JSON.stringify(options.spillDir)}, inlineLimit: ${options.inlineLimit}, logs: [] };
  const ${P}exit = process.exit, ${P}console = globalThis.console, ${P}flush = globalThis.__egoBrowserFlushRound;
  const ${P}sink = { write: (chunk) => { ${P}s.logs.push(String(chunk)); return true; } };
  process.exit = () => { throw Object.assign(new Error("process.exit() is not available inside ego-run; let the program end instead"), { code: "EGO_RUN_NO_EXIT" }); };
  if (typeof ${P}flush !== "function") {
    const capture = (prefix) => (...args) => ${P}s.logs.push(prefix + args.map((a) => typeof a === "string" ? a : ${P}inspect(a)).join(" ") + "\\n");
    globalThis.console = { ...${P}console, log: capture(""), info: capture(""), warn: capture("[warn] "), error: capture("[error] ") };
  }
  let ${P}timer, ${P}result;
  try {
    if (typeof globalThis.__egoBeginProgram === "function") globalThis.__egoBeginProgram();
    const ${P}value = await Promise.race([
      (async () => {
${program.body}
      })(),
      new Promise((_, reject) => { ${P}timer = setTimeout(() => reject(Object.assign(new Error("EGO_RUN_DEADLINE: the program ran longer than " + ${P}s.timeoutMs + " ms; the session will be rebuilt"), { code: "EGO_RUN_DEADLINE" })), ${P}s.timeoutMs); }),
    ]);
    ${P}result = { ok: true, value: ${P}value, ms: performance.now() - ${P}s.t0 };
  } catch (error) {
    ${P}result = { ok: false, error: { name: String(error?.name ?? "Error"), message: String(error?.message ?? error), stack: typeof error?.stack === "string" ? error.stack : undefined, code: typeof error?.code === "string" ? error.code : undefined }, ms: performance.now() - ${P}s.t0 };
  } finally {
    clearTimeout(${P}timer);
    process.exit = ${P}exit;
    globalThis.console = ${P}console;
    try { if (typeof globalThis.__egoEndProgram === "function") await Promise.race([globalThis.__egoEndProgram(), new Promise((resolve) => setTimeout(resolve, 2000))]); } catch {}
    try { if (typeof ${P}flush === "function") ${P}flush(${P}sink, !${P}result.ok); } catch (error) { ${P}s.logs.push("[ego-run] flush failed: " + (error?.message ?? error) + "\\n"); }
    ${P}result.logs = ${P}s.logs.join("");
    let json;
    try { json = JSON.stringify(${P}result, ${P}replacer()); } catch (error) { ${P}result.value = undefined; ${P}result.error = ${P}result.error ?? { name: "TypeError", message: "result is not serializable: " + (error?.message ?? error) }; json = JSON.stringify(${P}result, ${P}replacer()); }
    if (json.length > ${P}s.inlineLimit) {
      try {
        const fs = await import("node:fs/promises"), path = await import("node:path");
        await fs.mkdir(${P}s.spillDir, { recursive: true });
        const base = path.join(${P}s.spillDir, ${JSON.stringify(spillBase)});
        // Logs first: a program that only logs a lot must not spill its value.
        if (${P}result.logs.length > ${P}s.inlineLimit / 2) {
          const file = base + ".logs.txt", tail = ${P}result.logs.slice(-65536);
          await fs.writeFile(file, ${P}result.logs);
          ${P}result.logsFile = file; ${P}result.logsBytes = ${P}result.logs.length;
          ${P}result.logs = "[ego-run] " + ${P}result.logsBytes + " bytes of output written to " + file + "; the last 64 KB follow\\n" + tail;
          json = JSON.stringify(${P}result, ${P}replacer());
        }
        if (json.length > ${P}s.inlineLimit) {
          const file = base + ".json";
          await fs.writeFile(file, JSON.stringify(${P}result.value, ${P}replacer()));
          ${P}result.valueFile = file; ${P}result.valueBytes = json.length; delete ${P}result.value;
          json = JSON.stringify(${P}result, ${P}replacer());
        }
      } catch (error) { ${P}result.value = undefined; ${P}result.error = { name: "Error", message: "result too large and could not be spilled: " + (error?.message ?? error) }; json = JSON.stringify(${P}result, ${P}replacer()); }
    }
    process.stdout.write(${marker} + json + "\\n");
  }
})();
function ${P}replacer() {
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
function ${P}inspect(value) {
  try { return JSON.stringify(value, ${P}replacer()) ?? String(value); } catch { return String(value); }
}
`;
}

export type ResultEnvelope = {
  ok: boolean;
  value?: unknown;
  valueFile?: string;
  valueBytes?: number;
  /** Absolute path of the full output when the logs exceeded the limit. */
  logsFile?: string;
  logsBytes?: number;
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
