import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr,
} from "node:process";
import { parse } from "acorn";

import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";
import { addPageContextHint } from "./page-context-guard.js";
import {
  bufferOutput,
  createRoundConsole,
  flushSink,
  resetSink,
} from "./output-sink.js";

type WritableLike = {
  write(chunk: string): unknown;
};

type ReadableLike = {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type RunMainOptions = {
  argv?: string[];
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: ReadableLike;
  stdinText?: string;
};

export const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  const task = await taskSpace('demo')
  const page = task.page('p1')
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.
`;

export const USAGE = `Usage:
  ego-browser <<'JS'
  const task = await taskSpace('demo')
  const page = task.page('p1')
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS
`;

export async function runMain(options: RunMainOptions = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || processStdout;
  const stderr = options.stderr || processStderr;

  if (argv[0] === "-h" || argv[0] === "--help") {
    write(stdout, HELP);
    return 0;
  }
  if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  }

  const code =
    options.stdinText !== undefined
      ? options.stdinText
      : await readAll(options.stdin || processStdin);
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }

  await execute(code, stdout);
  return 0;
}

async function execute(code: string, stdout: WritableLike) {
  resetSink();
  const context = await executionContext();
  // Helpers remain globally visible for loaded agent modules, but console is a
  // lexical round parameter so the CLI never replaces Node's process console.
  const globalHelpers = { ...context };
  delete globalHelpers.console;
  Object.assign(globalThis, globalHelpers);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction(...names, `"use strict";\n${code}`);
  } catch (error) {
    flushSink(stdout, true);
    throw userScriptSyntaxError(code, error);
  }
  try {
    await fn(...values);
  } catch (error) {
    // The thrown Error surfaces the hard-stop message on its own, so flush as a thrown
    // completion (drop the buffer, stay silent) and let it propagate.
    flushSink(stdout, true);
    throw addPageContextHint(error);
  }
  flushSink(stdout, false);
}

function userScriptSyntaxError(code: string, original: unknown): SyntaxError {
  const originalMessage =
    original instanceof Error ? original.message : String(original);
  try {
    // V8 omits source locations for Function-constructor syntax errors. Acorn
    // only runs after compilation fails and recovers the location in the
    // user's script; wrapping preserves top-level await support.
    parse(`async function __egoBrowserUserScript__() {\n${code}\n}`, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
  } catch (parseError) {
    const location = (parseError as { loc?: { line: number; column: number } })
      .loc;
    if (location && location.line >= 2) {
      const userLineNumber = location.line - 1;
      const sourceLine = code.split(/\r?\n/)[userLineNumber - 1] ?? "";
      const columnNumber = location.column + 1;
      const error = new SyntaxError(
        `Browser script syntax error at line ${userLineNumber}, column ${columnNumber}: ${originalMessage}\n` +
          `${userLineNumber} | ${sourceLine}\n` +
          `${" ".repeat(String(userLineNumber).length + 3 + location.column)}^`,
      );
      (error as SyntaxError & { cause?: unknown }).cause = original;
      return error;
    }
  }
  return original instanceof SyntaxError
    ? original
    : new SyntaxError(originalMessage);
}

export async function executionContext() {
  const agentHelpers = await helpers.loadAgentHelpers();
  // Single source of truth for the agent-facing surface: the same helperContext()
  // that installEgoSdk() exposes in the browser runtime, so the CLI and SDK paths
  // cannot drift apart (and `help` exists in both).
  const context: Record<string, any> = helpers.helperContext(agentHelpers);
  context.cliLog = (...args: unknown[]) => {
    // Buffer rather than write through; execute() flushes (or discards on hard stop)
    // once the script settles. Keeps the CLI path identical to the SDK path.
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
  };
  // A lexical parameter shadows Node's global console without mutating it.
  context.console = createRoundConsole();
  return context;
}

function readAll(stream: ReadableLike) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

function write(stream: WritableLike, text: string) {
  stream.write(text);
}
