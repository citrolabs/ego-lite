#!/usr/bin/env node
// `ego-run`: the thin CLI agents call instead of `ego-browser nodejs`.
//
//   ego-run --session <id> [--timeout-ms N] [--sdk-path P] [--file F | -e CODE] [--json]   (program on stdin)
//   ego-run session new [--prefix NAME] | list | close <id> | close --all | reset <id>
//   ego-run status
//   ego-run daemon start [--detach] | stop | status | logs [--lines N]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { daemonStatus, request, spawnDetachedDaemon } from "./client.js";
import { daemonPaths } from "./paths.js";
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  ProtocolError,
  type ErrorResponse,
  type ExecResponse,
  type Response,
} from "./protocol.js";

const USAGE = `ego-run: run browser programs in a persistent ego-browser session

Usage:
  ego-run --session <id> [options] <<'EOF' ...program... EOF
  ego-run --session <id> [options] --file program.mjs
  ego-run --session <id> [options] -e "await taskSpace('x')"
  ego-run session new [--prefix NAME] | list | close <id> | close --all | reset <id>
  ego-run status
  ego-run daemon start [--detach] | stop | status | logs [--lines N]

Options:
  --session <id>       Session id, [a-z0-9-], up to 64 characters (required for programs)
  --timeout-ms <n>     Program deadline, default 60000, max 180000
  --sdk-path <file>    Pass --sdk-path to ego-browser nodejs (fixed per session)
  --json               Print the raw daemon response
  --version, -h

Environment:
  EGO_RUN_FALLBACK=1   Run the program once with "ego-browser nodejs" when the daemon is down
  EGO_RUN_STATE_DIR    Override the daemon state directory
  EGO_BROWSER_BIN      ego-browser executable the daemon starts (read when the daemon starts)
`;

type Flags = { positional: string[]; options: Map<string, string | true> };

function parseArgs(argv: string[]): Flags {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  const valued = new Set([
    "--session",
    "--timeout-ms",
    "--sdk-path",
    "--file",
    "-e",
    "--prefix",
    "--lines",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--") && arg.includes("=")) {
      const [key, value] = arg.split(/=(.*)/s);
      options.set(key, value);
    } else if (valued.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined)
        throw new ProtocolError(ErrorCodes.BAD_REQUEST, `${arg} needs a value`);
      options.set(arg, value);
      i += 1;
    } else if (arg.startsWith("-") && arg !== "-") {
      options.set(arg, true);
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const paths = daemonPaths();
  if (options.has("--version")) {
    process.stdout.write(`ego-run protocol ${PROTOCOL_VERSION}\n`);
    return 0;
  }
  if (options.has("-h") || options.has("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, ...rest] = positional;

  if (command === "daemon") {
    const sub = rest[0];
    if (sub === "start") {
      if (await daemonStatus(paths)) {
        process.stderr.write(
          `[ego-run] daemon already running (${paths.endpoint})\n`,
        );
        return 0;
      }
      if (options.has("--detach")) {
        const pid = await spawnDetachedDaemon(paths);
        process.stderr.write(
          `[ego-run] daemon started (pid ${pid}, log ${paths.logFile})\n`,
        );
        return 0;
      }
      const { runDaemon } = await import("./server.js");
      const daemon = await runDaemon();
      process.stderr.write(
        `[ego-run] daemon listening on ${daemon.paths.endpoint} (pid ${process.pid}); Ctrl-C to stop\n`,
      );
      await new Promise(() => {}); // runs until a signal stops it
      return 0;
    }
    if (sub === "stop") {
      const status = await daemonStatus(paths);
      if (!status) {
        process.stderr.write("[ego-run] daemon is not running\n");
        return 0;
      }
      await request(paths, { cmd: "shutdown" }, { timeoutMs: 5_000 });
      process.stderr.write("[ego-run] daemon stopping\n");
      return 0;
    }
    if (sub === "status") {
      const status = await daemonStatus(paths);
      if (!status)
        fail(`[ego-run] daemon is not running (${paths.endpoint})`, 3);
      printJson(status);
      return 0;
    }
    if (sub === "logs") {
      const lines = Number(options.get("--lines") ?? 100);
      let text = "";
      try {
        text = readFileSync(paths.logFile, "utf8");
      } catch {
        fail(`[ego-run] no log file at ${paths.logFile}`, 3);
      }
      const all = text.split("\n").filter(Boolean);
      process.stdout.write(`${all.slice(-lines).join("\n")}\n`);
      return 0;
    }
    fail(USAGE, 2);
  }

  if (command === "session") {
    const sub = rest[0];
    if (sub === "new") {
      const response = await request(paths, {
        cmd: "session.new",
        prefix: options.get("--prefix"),
      });
      if (!response.ok)
        fail(`[ego-run] ${(response as ErrorResponse).error.message}`);
      process.stdout.write(
        `${(response as unknown as { session: string }).session}\n`,
      );
      return 0;
    }
    if (sub === "list") {
      const response = await request(paths, { cmd: "session.list" });
      printJson(
        response.ok
          ? (response as unknown as { sessions: unknown }).sessions
          : response,
      );
      return response.ok ? 0 : 1;
    }
    if (sub === "close") {
      const response = await request(paths, {
        cmd: "session.close",
        session: rest[1],
        all: options.has("--all"),
      });
      printJson(response);
      return response.ok ? 0 : 1;
    }
    if (sub === "reset") {
      const response = await request(paths, {
        cmd: "session.reset",
        session: rest[1],
      });
      printJson(response);
      return response.ok ? 0 : 1;
    }
    fail(USAGE, 2);
  }

  if (command === "status") {
    const status = await daemonStatus(paths);
    if (!status)
      fail(
        `[ego-run] daemon is not running (${paths.endpoint}); start it with "ego-run daemon start"`,
        3,
      );
    printJson(status);
    return 0;
  }

  if (command !== undefined)
    fail(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`, 2);

  // Run a program.
  const session = options.get("--session");
  if (typeof session !== "string")
    fail(`--session <id> is required\n\n${USAGE}`, 2);
  let program: string;
  if (options.has("--file")) {
    program = readFileSync(String(options.get("--file")), "utf8");
  } else if (options.has("-e")) {
    program = String(options.get("-e"));
  } else {
    program = await readStdin();
  }
  const timeoutMs = options.has("--timeout-ms")
    ? Number(options.get("--timeout-ms"))
    : undefined;
  const sdkPath = options.has("--sdk-path")
    ? String(options.get("--sdk-path"))
    : undefined;
  let raw: Response;
  try {
    raw = await request(paths, {
      cmd: "exec",
      session,
      program,
      timeoutMs,
      sdkPath,
    });
  } catch (error) {
    if (
      (error as ProtocolError).code === ErrorCodes.DAEMON_UNAVAILABLE &&
      process.env.EGO_RUN_FALLBACK === "1"
    ) {
      return runOnceWithoutDaemon(program, sdkPath);
    }
    throw error;
  }
  if (options.has("--json")) {
    printJson(raw);
    return raw.ok ? 0 : 1;
  }
  if (!("session" in raw)) {
    fail(
      `[ego-run] ${(raw as ErrorResponse).error?.message ?? "request failed"}`,
    );
  }
  const response = raw as ExecResponse;
  if (response.session.fresh) {
    process.stderr.write(
      response.session.rebuiltReason
        ? `[ego-run] session "${session}" was rebuilt (${response.session.rebuiltReason}); variables and Page handles from earlier calls are gone, call taskSpace(...) again\n`
        : `[ego-run] session "${session}" started with a fresh context\n`,
    );
  }
  if (response.logs)
    process.stdout.write(
      response.logs.endsWith("\n") ? response.logs : `${response.logs}\n`,
    );
  if (response.valueFile) {
    process.stdout.write(
      `[ego-run] result is ${response.valueFile} (too large to print)\n`,
    );
  } else if (response.value !== undefined && response.value !== null) {
    process.stdout.write(
      typeof response.value === "string"
        ? `${response.value}\n`
        : `${JSON.stringify(response.value, null, 2)}\n`,
    );
  }
  if (!response.ok && response.error) {
    const detail =
      response.error.stack &&
      response.error.stack.includes(response.error.message)
        ? response.error.stack
        : `${response.error.name}: ${response.error.message}`;
    process.stderr.write(`${detail}\n`);
    return 1;
  }
  return 0;
}

function runOnceWithoutDaemon(
  program: string,
  sdkPath: string | undefined,
): Promise<number> {
  process.stderr.write(
    "[ego-run] daemon unavailable; running once with ego-browser nodejs (persistent:false, variables will not survive this call)\n",
  );
  const bin = process.env.EGO_BROWSER_BIN ?? "ego-browser";
  const args = ["nodejs", ...(sdkPath ? ["--sdk-path", sdkPath] : [])];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", (error) => {
      process.stderr.write(`[ego-run] cannot start ${bin}: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.stdin.end(program);
  });
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[ego-run] ${error?.message ?? error}\n`);
      process.exitCode =
        (error as ProtocolError)?.code === ErrorCodes.DAEMON_UNAVAILABLE
          ? 3
          : 1;
    },
  );
}
