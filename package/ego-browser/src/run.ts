import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr,
} from "node:process";
import { start as startNodeRepl } from "node:repl";
import { PassThrough, Readable } from "node:stream";

import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";
import {
  beginOutputBoundary,
  bufferOutput,
  finishOutputBoundary,
  flushSink,
} from "./output-sink.js";

type WritableLike = {
  write(chunk: string): unknown;
};

type ReadableLike = {
  isTTY?: boolean;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type RunServices = {
  resetConnection(): Promise<void>;
  printUpdateBanner(stream: WritableLike): void;
  runDoctor(stream: WritableLike): Promise<number>;
};

export type RunMainOptions = {
  argv?: string[];
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: ReadableLike;
  stdinText?: string;
  env?: Record<string, string | undefined>;
  services?: Partial<RunServices>;
};

export const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser
  repl> .cell
  repl> await waitForLoadState()
  repl> console.log(await pageInfo())
  repl> .end

Helpers are pre-imported and the browser connection is prepared automatically.

Commands:
  ego-browser --doctor         inspect browser and connection state
  ego-browser --reload         reset the browser connection on next call
  ego-browser --repl           start interactive cell mode
`;

export const USAGE = `Usage:
  ego-browser
  ego-browser --repl
  ego-browser <<'JS'           # compatibility mode for piped scripts
  console.log(await pageInfo())
  JS
`;

export async function runMain(options: RunMainOptions = {}) {
  const argv = [...(options.argv || process.argv.slice(2))];
  const stdout = options.stdout || processStdout;
  const stderr = options.stderr || processStderr;
  const env = options.env || process.env;
  const services = {
    resetConnection: async () => {},
    printUpdateBanner: () => {},
    runDoctor: async () => 0,
    ...options.services,
  };

  if (argv[0] === "-h" || argv[0] === "--help") {
    write(stdout, HELP);
    return 0;
  }
  if (argv[0] === "--doctor") {
    return services.runDoctor(stdout);
  }
  if (argv[0] === "--reload") {
    await services.resetConnection();
    write(stdout, "browser connection reset on next call\n");
    return 0;
  }
  let interactive = false;
  while (argv.length > 0) {
    if (argv[0] === "--debug-clicks") {
      env.EGO_BROWSER_DEBUG_CLICKS = "1";
      argv.shift();
      continue;
    }
    if (argv[0] === "--repl" || argv[0] === "--interactive") {
      interactive = true;
      argv.shift();
      continue;
    }
    break;
  }
  if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  }

  const stdin = options.stdin || processStdin;
  if (interactive || (options.stdinText === undefined && stdin.isTTY)) {
    services.printUpdateBanner(stderr);
    return runInteractive({
      stdin,
      stdinText: options.stdinText,
      stdout,
      stderr,
    });
  }

  const code =
    options.stdinText !== undefined ? options.stdinText : await readAll(stdin);
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }

  services.printUpdateBanner(stderr);
  await execute(code, stdout);
  return 0;
}

async function execute(code: string, stdout: WritableLike) {
  const context = await executionContext();
  Object.assign(globalThis, context);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  const fn = new AsyncFunction(...names, `"use strict";\n${code}`);
  beginOutputBoundary();
  try {
    await fn(...values);
  } catch (error) {
    // The thrown Error surfaces the hard-stop message on its own, so flush as a thrown
    // completion (drop the buffer, stay silent) and let it propagate.
    finishOutputBoundary(stdout, true);
    throw error;
  }
  finishOutputBoundary(stdout, false);
}

async function runInteractive(options: {
  stdin: ReadableLike;
  stdinText?: string;
  stdout: WritableLike;
  stderr: WritableLike;
}) {
  const evaluator = await createReplEvaluator();
  const input =
    options.stdinText !== undefined
      ? Readable.from([options.stdinText])
      : (options.stdin as any);
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let collecting = false;
  let buffer: string[] = [];

  write(
    options.stdout,
    "ego-browser nodejs REPL. Type .exit to quit, .cell/.end for multiline.\n",
  );
  writePrompt(options.stdout);

  try {
    for await (const line of rl) {
      const command = line.trim();
      if (command === ".exit") {
        rl.close();
        return 0;
      }

      if (collecting) {
        if (command === ".cancel") {
          collecting = false;
          buffer = [];
          writePrompt(options.stdout);
          continue;
        }
        if (command === ".end") {
          collecting = false;
          await evaluateInteractiveCell(buffer.join("\n"), evaluator, options);
          buffer = [];
          writePrompt(options.stdout);
          continue;
        }
        buffer.push(line);
        continue;
      }

      if (command === "") {
        writePrompt(options.stdout);
        continue;
      }
      if (command === ".cell") {
        collecting = true;
        buffer = [];
        continue;
      }
      if (command === ".cancel" || command === ".end") {
        write(options.stderr, "Use .cell to start a multiline block\n");
        writePrompt(options.stdout);
        continue;
      }

      await evaluateInteractiveCell(line, evaluator, options);
      writePrompt(options.stdout);
    }
  } finally {
    rl.close();
    evaluator.close();
  }

  if (collecting) {
    write(options.stderr, "Expected .end before EOF\n");
    return 2;
  }
  return 0;
}

async function createReplEvaluator() {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = startNodeRepl({
    prompt: "",
    input,
    output,
    terminal: false,
    useGlobal: true,
  });
  const context = await executionContext();
  Object.assign(globalThis, context);
  Object.assign(server.context, context);
  return {
    async evaluate(code: string): Promise<{ error: Error | null; value: any }> {
      return new Promise((resolve) => {
        server.eval(code, server.context, "repl", (error, value) => {
          resolve({ error: error || null, value });
        });
      });
    },
    writer(value: any): string {
      return server.writer(value);
    },
    close() {
      server.close();
      input.destroy();
      output.destroy();
    },
  };
}

async function evaluateInteractiveCell(
  code: string,
  evaluator: Awaited<ReturnType<typeof createReplEvaluator>>,
  options: { stdout: WritableLike; stderr: WritableLike },
) {
  if (!code.trim()) {
    return;
  }
  beginOutputBoundary();
  const { error, value } = await evaluator.evaluate(code);
  const flush = finishOutputBoundary(options.stdout, Boolean(error));
  if (error) {
    write(options.stderr, `${formatReplError(error)}\n`);
    return;
  }
  if (!flush.hardStop && value !== undefined) {
    write(options.stdout, `${evaluator.writer(value)}\n`);
  }
}

function formatReplError(error: Error) {
  if (error?.stack) {
    const headline = `${error.name}: ${error.message}`;
    if (error.stack.includes(headline)) {
      return error.stack.replace(headline, `Uncaught ${headline}`);
    }
    return `Uncaught ${error.stack}`;
  }
  return `Uncaught ${error?.message || String(error)}`;
}

function writePrompt(stdout: WritableLike) {
  write(stdout, "repl> ");
}

export async function executionContext() {
  const agentHelpers = await helpers.loadAgentHelpers();
  // Single source of truth for the agent-facing surface: the same helperContext()
  // that installEgoSdk() exposes in the browser runtime, so the CLI and SDK paths
  // cannot drift apart (and `help` exists in both).
  const context: Record<string, any> = helpers.helperContext(agentHelpers);
  // Route the agent's primary output channel (console.log) through the output sink:
  // each stdin script or REPL cell flushes (or discards on hard stop) when it settles.
  // console.error/warn are left untouched.
  console.log = (...args: unknown[]) => {
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}\n`);
  };
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
