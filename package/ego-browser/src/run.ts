import { readFile } from "node:fs/promises";
import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr,
} from "node:process";

import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";
import { installLegacySkillGuards } from "./legacy-skill-guard.js";
import { bufferOutput, flushSink, resetSink } from "./output-sink.js";

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
  await page.waitForLoadState()
  console.log(await page.info())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.

On shells without heredocs (PowerShell, cmd), pass a script file or -e instead;
all three forms run through the same execution path.

Commands:
  ego-browser <script.js>      run JavaScript from a file
  ego-browser -e <code>        run inline JavaScript (alias: --eval)
  ego-browser --doctor         inspect browser and connection state
  ego-browser --reload         reset the browser connection on next call
`;

export const USAGE = `Usage:
  ego-browser <<'JS'
  console.log(await page.info())
  JS

  ego-browser <script.js>
  ego-browser -e <code>
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
  if (argv[0] === "--debug-clicks") {
    env.EGO_BROWSER_DEBUG_CLICKS = "1";
    argv.shift();
  }

  // Three input forms feed the same execution path: inline -e code, a script
  // file named by the one positional argument, and stdin (the default). The
  // file and -e forms exist for shells without heredocs (PowerShell, cmd),
  // where piping into stdin re-encodes the script through the shell.
  let code: string;
  if (argv[0] === "-e" || argv[0] === "--eval") {
    if (argv.length !== 2) {
      write(stderr, USAGE);
      return 2;
    }
    code = argv[1];
  } else if (argv.length === 1 && !argv[0].startsWith("-")) {
    try {
      code = await readFile(argv[0], "utf8");
    } catch (error) {
      write(
        stderr,
        `cannot read script file ${JSON.stringify(argv[0])}: ${error?.message || error}\n`,
      );
      return 1;
    }
  } else if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  } else {
    code =
      options.stdinText !== undefined
        ? options.stdinText
        : await readAll(options.stdin || processStdin);
  }
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }

  services.printUpdateBanner(stderr);
  await execute(code, stdout);
  return 0;
}

async function execute(code: string, stdout: WritableLike) {
  resetSink();
  const context = await executionContext();
  Object.assign(globalThis, context);
  installLegacySkillGuards(globalThis as Record<string, unknown>);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  const fn = new AsyncFunction(...names, `"use strict";\n${code}`);
  let thrown;
  try {
    await fn(...values);
  } catch (error) {
    thrown = error;
  }
  try {
    await helpers.stopScreencast();
  } catch (error) {
    thrown ??= error;
  }
  // A thrown Error surfaces a hard-stop message on its own, so flush as a thrown
  // completion (drop the buffer, stay silent) and let it propagate.
  flushSink(stdout, Boolean(thrown));
  if (thrown) throw thrown;
}

export async function executionContext() {
  const agentHelpers = await helpers.loadAgentHelpers();
  // Single source of truth for the agent-facing surface: the same helperContext()
  // that installEgoSdk() exposes in the browser runtime, so the CLI and SDK paths
  // cannot drift apart (and `help` exists in both).
  const context: Record<string, any> = helpers.helperContext(agentHelpers);
  // Route the agent's primary output channel (console.log) through the output sink:
  // execute() flushes (or discards on hard stop) once the script settles, keeping the
  // CLI path identical to the SDK path. console.error/warn are left untouched. Each
  // heredoc runs in its own short-lived process, so overriding the global is per-run.
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
