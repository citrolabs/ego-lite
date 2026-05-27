import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";

import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";

type WritableLike = {
  write(chunk: string): unknown;
};

type ReadableLike = {
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
  ego-browser <<'JS'
  await waitForLoad()
  cliLog(await pageInfo())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.

Commands:
  ego-browser --doctor         inspect browser and connection state
  ego-browser --reload         reset the browser connection on next call
`;

export const USAGE = `Usage:
  ego-browser <<'JS'
  cliLog(await pageInfo())
  JS
`;

export async function runMain(options: RunMainOptions = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || processStdout;
  const stderr = options.stderr || processStderr;
  const env = options.env || process.env;
  const services = {
    resetConnection: async () => {},
    printUpdateBanner: () => {},
    runDoctor: async () => 0,
    ...options.services
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
  if (argv[0] === "--debug-clicks") {
    env.EGO_BROWSER_DEBUG_CLICKS = "1";
    argv.shift();
  }
  if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  }

  const code = options.stdinText !== undefined ? options.stdinText : await readAll(options.stdin || processStdin);
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }

  services.printUpdateBanner(stderr);
  await execute(code, stdout);
  return 0;
}

async function execute(code: string, stdout: WritableLike) {
  const context = await executionContext(stdout);
  Object.assign(globalThis, context);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  const fn = new AsyncFunction(...names, `"use strict";\n${code}`);
  await fn(...values);
}

export async function executionContext(stdout: WritableLike = processStdout) {
  const agentHelpers = await helpers.loadAgentHelpers();
  const context = publicContext({ ...helpers, ...agentHelpers });
  context.cliLog = (...args) => {
    write(stdout, `${args.map(formatCliLogValue).join(" ")}\n`);
  };
  return context;
}

function publicContext(moduleLike: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [name, value] of Object.entries(moduleLike)) {
    if (name === "__testing" || name.startsWith("_")) {
      continue;
    }
    out[name] = value;
  }
  return out;
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
