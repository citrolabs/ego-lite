// Client side of the daemon protocol, shared by the `ego-run` CLI.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DaemonPaths } from "./paths.js";
import {
  ErrorCodes,
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  type Response,
} from "./protocol.js";

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${process.pid}-${requestSeq}`;
}

export function readToken(paths: DaemonPaths): string | null {
  try {
    return readFileSync(paths.tokenFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Send one request and return the daemon's response line. */
export function request(
  paths: DaemonPaths,
  body: Record<string, unknown>,
  { timeoutMs = MAX_TIMEOUT_MS + 15_000 }: { timeoutMs?: number } = {},
): Promise<Response> {
  const token = readToken(paths);
  if (!token) {
    return Promise.reject(
      new ProtocolError(
        ErrorCodes.DAEMON_UNAVAILABLE,
        `no daemon token at ${paths.tokenFile}; start it with "ego-run daemon start"`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const socket = connect(paths.endpoint);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ProtocolError(
              ErrorCodes.DAEMON_UNAVAILABLE,
              `the daemon did not answer within ${timeoutMs} ms`,
            ),
          ),
        ),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ v: PROTOCOL_VERSION, token, id: nextRequestId(), ...body })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(() => resolve(JSON.parse(buffer.slice(0, newline))));
      } catch (error) {
        finish(() =>
          reject(
            new ProtocolError(
              ErrorCodes.DAEMON_UNAVAILABLE,
              `unreadable daemon reply: ${(error as Error).message}`,
            ),
          ),
        );
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const unavailable =
        error.code === "ENOENT" || error.code === "ECONNREFUSED";
      finish(() =>
        reject(
          new ProtocolError(
            ErrorCodes.DAEMON_UNAVAILABLE,
            unavailable
              ? `the ego-run daemon is not running (${paths.endpoint}); start it with "ego-run daemon start"`
              : `cannot reach the daemon: ${error.message}`,
          ),
        ),
      );
    });
    socket.on("end", () => {
      finish(() =>
        reject(
          new ProtocolError(
            ErrorCodes.DAEMON_UNAVAILABLE,
            "the daemon closed the connection without a reply",
          ),
        ),
      );
    });
  });
}

export async function daemonStatus(
  paths: DaemonPaths,
): Promise<Response | null> {
  try {
    return await request(paths, { cmd: "status" }, { timeoutMs: 3_000 });
  } catch (error) {
    if ((error as ProtocolError).code === ErrorCodes.DAEMON_UNAVAILABLE)
      return null;
    throw error;
  }
}

export function serverScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "server.js");
}

/** Start the daemon as a detached process and wait until it answers. */
export async function spawnDetachedDaemon(
  paths: DaemonPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const child = spawn(process.execPath, [serverScriptPath()], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await daemonStatus(paths);
    if (status?.ok) return child.pid ?? 0;
    if (child.exitCode !== null) break;
  }
  throw new ProtocolError(
    ErrorCodes.DAEMON_UNAVAILABLE,
    `the daemon did not come up; check ${paths.logFile} or run "ego-run daemon start" in the foreground`,
  );
}
