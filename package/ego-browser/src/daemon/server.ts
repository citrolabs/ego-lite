// The ego-run daemon: a single-instance local server that owns the REPL
// sessions. Started by hand during the POC (`ego-run daemon start`); the thin
// CLI never spawns it on its own, so it does not inherit an agent sandbox.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { daemonPaths, type DaemonPaths } from "./paths.js";
import {
  DAEMON_IDLE_MS,
  ErrorCodes,
  PROTOCOL_VERSION,
  ProtocolError,
  serializeError,
  type Request,
  type Response,
} from "./protocol.js";
import {
  SessionManager,
  type SessionManagerOptions,
} from "./session-manager.js";

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 30_000;
const VERSION_CHECK_MS = 60_000;

export type DaemonOptions = {
  paths?: DaemonPaths;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  sessions?: Partial<SessionManagerOptions>;
  /** Test seam: skip the `ego-browser --version` watch. */
  watchVersion?: boolean;
};

export class Daemon {
  readonly paths: DaemonPaths;
  readonly sessions: SessionManager;
  readonly startedAt = Date.now();
  readonly bin: string;
  #server: Server | null = null;
  #token = "";
  #lastActivity = Date.now();
  #timers: NodeJS.Timeout[] = [];
  #egoBrowserVersion: string | null = null;
  #stopping: Promise<void> | null = null;
  readonly #idleMs: number;
  readonly #watchVersion: boolean;
  #logFd: number | null = null;

  constructor(options: DaemonOptions = {}) {
    this.paths = options.paths ?? daemonPaths();
    this.bin = options.bin ?? process.env.EGO_BROWSER_BIN ?? "ego-browser";
    this.#idleMs = options.idleMs ?? DAEMON_IDLE_MS;
    this.#watchVersion = options.watchVersion ?? true;
    this.sessions = new SessionManager({
      bin: this.bin,
      spillDir: this.paths.spillDir,
      env: options.env,
      log: (line) => this.log(line),
      ...options.sessions,
    });
  }

  get token() {
    return this.#token;
  }

  log(line: string) {
    const entry = `${new Date().toISOString()} ${line}\n`;
    try {
      if (this.#logFd === null) {
        this.#logFd = openSync(this.paths.logFile, "a");
      }
      writeSync(this.#logFd, entry);
      if (statSync(this.paths.logFile).size > LOG_ROTATE_BYTES) {
        closeSync(this.#logFd);
        this.#logFd = null;
        renameSync(this.paths.logFile, `${this.paths.logFile}.1`);
      }
    } catch {
      // logging must never take the daemon down
    }
  }

  async start(): Promise<void> {
    mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.paths.spillDir, { recursive: true, mode: 0o700 });
    // Order matters: refuse on a live lock, then on a live socket (the lock
    // file can be missing or unreadable while a daemon still owns the
    // socket), and only then write our own lock, so another daemon's files
    // are never touched on the way out.
    this.#checkLock();
    if (process.platform !== "win32" && existsSync(this.paths.endpoint)) {
      if (await endpointAlive(this.paths.endpoint)) {
        throw new ProtocolError(
          ErrorCodes.BAD_REQUEST,
          `an ego-run daemon is already listening on ${this.paths.endpoint}`,
        );
      }
      unlinkSync(this.paths.endpoint); // stale socket from a crashed daemon
    }
    this.#writeLock();
    this.#token = this.#loadOrCreateToken();
    this.#server = createServer((socket) => this.#serve(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.paths.endpoint, () => {
        this.#server!.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") {
      try {
        const { chmodSync } = await import("node:fs");
        chmodSync(this.paths.endpoint, 0o600);
      } catch {
        // best effort
      }
    }
    this.#timers.push(setInterval(() => this.#tick(), SWEEP_INTERVAL_MS));
    if (this.#watchVersion) {
      this.#egoBrowserVersion = await this.#readEgoBrowserVersion();
      this.#timers.push(
        setInterval(() => void this.#checkVersion(), VERSION_CHECK_MS),
      );
    }
    for (const timer of this.#timers) timer.unref();
    this.log(
      `start pid=${process.pid} endpoint=${this.paths.endpoint} bin=${this.bin} version=${this.#egoBrowserVersion ?? "?"} protocol=${PROTOCOL_VERSION}`,
    );
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      this.log(`stop: ${reason}`);
      for (const timer of this.#timers) clearInterval(timer);
      this.sessions.closeAll(reason);
      await new Promise<void>((resolve) =>
        this.#server ? this.#server.close(() => resolve()) : resolve(),
      );
      for (const file of [this.paths.endpoint, this.paths.lockFile]) {
        try {
          if (process.platform === "win32" && file === this.paths.endpoint)
            continue;
          unlinkSync(file);
        } catch {
          // already gone
        }
      }
      if (this.#logFd !== null) {
        closeSync(this.#logFd);
        this.#logFd = null;
      }
    })();
    return this.#stopping;
  }

  /** Throw when the lock file names a live process other than this one. */
  #checkLock() {
    try {
      const pid = Number(readFileSync(this.paths.lockFile, "utf8").trim());
      if (pid && pid !== process.pid && processAlive(pid)) {
        throw new ProtocolError(
          ErrorCodes.BAD_REQUEST,
          `an ego-run daemon is already running (pid ${pid})`,
        );
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      // no lock, or an unreadable one
    }
  }

  #writeLock() {
    writeFileSync(this.paths.lockFile, `${process.pid}\n`, { mode: 0o600 });
  }

  #loadOrCreateToken(): string {
    try {
      const token = readFileSync(this.paths.tokenFile, "utf8").trim();
      if (token.length >= 32) return token;
    } catch {
      // create below
    }
    const token = randomBytes(24).toString("hex");
    writeFileSync(this.paths.tokenFile, `${token}\n`, { mode: 0o600 });
    return token;
  }

  #serve(socket: Socket) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      socket.removeAllListeners("data");
      void this.#handleLine(line).then((response) => {
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    socket.on("error", () => {
      // client went away; nothing to do
    });
  }

  async #handleLine(line: string): Promise<Response> {
    let request: Request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      return failure(
        "?",
        new ProtocolError(
          ErrorCodes.BAD_REQUEST,
          `unreadable request: ${(error as Error).message}`,
        ),
      );
    }
    const id = typeof request?.id === "string" ? request.id : "?";
    if (!request || typeof request !== "object") {
      return failure(
        id,
        new ProtocolError(
          ErrorCodes.BAD_REQUEST,
          "request must be a JSON object",
        ),
      );
    }
    if (request.v !== PROTOCOL_VERSION) {
      return failure(
        id,
        new ProtocolError(
          ErrorCodes.VERSION_MISMATCH,
          `daemon speaks protocol ${PROTOCOL_VERSION}, client sent ${request.v}; run "ego-run daemon stop" then "ego-run daemon start"`,
        ),
      );
    }
    if (request.token !== this.#token) {
      return failure(
        id,
        new ProtocolError(ErrorCodes.UNAUTHORIZED, "bad token"),
      );
    }
    this.#lastActivity = Date.now();
    try {
      return await this.#dispatch(request, id);
    } catch (error) {
      return failure(id, error);
    }
  }

  async #dispatch(request: Request, id: string): Promise<Response> {
    switch (request.cmd) {
      case "exec":
        return this.sessions.exec(request, id);
      case "session.new":
        return { id, ok: true, session: this.sessions.newId(request.prefix) };
      case "session.list":
        return { id, ok: true, sessions: this.sessions.list() };
      case "session.close": {
        if (request.all)
          return { id, ok: true, closed: this.sessions.closeAll() };
        if (!request.session)
          throw new ProtocolError(
            ErrorCodes.BAD_REQUEST,
            "session.close needs a session id or all=true",
          );
        return {
          id,
          ok: true,
          closed: this.sessions.close(request.session) ? 1 : 0,
        };
      }
      case "session.reset":
        return { id, ok: true, reset: this.sessions.reset(request.session) };
      case "status":
        return {
          id,
          ok: true,
          pid: process.pid,
          protocol: PROTOCOL_VERSION,
          startedAt: new Date(this.startedAt).toISOString(),
          uptimeMs: Date.now() - this.startedAt,
          bin: this.bin,
          egoBrowserVersion: this.#egoBrowserVersion,
          endpoint: this.paths.endpoint,
          logFile: this.paths.logFile,
          sessions: this.sessions.list(),
        };
      case "shutdown":
        setTimeout(
          () =>
            void this.stop("shutdown requested").then(() => process.exit(0)),
          10,
        );
        return { id, ok: true, stopping: true };
      default:
        throw new ProtocolError(
          ErrorCodes.BAD_REQUEST,
          `unknown command ${JSON.stringify((request as { cmd?: unknown }).cmd)}`,
        );
    }
  }

  #tick() {
    this.sessions.sweep();
    if (
      this.sessions.size === 0 &&
      Date.now() - this.#lastActivity > this.#idleMs
    ) {
      void this.stop("idle").then(() => process.exit(0));
    }
  }

  async #readEgoBrowserVersion(): Promise<string | null> {
    try {
      // The CLI prints its version on stderr.
      const { stdout, stderr } = await promisify(execFile)(
        this.bin,
        ["--version"],
        { timeout: 10_000 },
      );
      return (
        `${stdout}\n${stderr}`
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) || null
      );
    } catch (error) {
      this.log(`version check failed: ${(error as Error).message}`);
      return null;
    }
  }

  async #checkVersion() {
    const version = await this.#readEgoBrowserVersion();
    if (
      version &&
      this.#egoBrowserVersion &&
      version !== this.#egoBrowserVersion
    ) {
      this.log(
        `ego-browser changed ${this.#egoBrowserVersion} -> ${version}; closing all sessions`,
      );
      this.sessions.closeAll("ego lite was updated");
    }
    if (version) this.#egoBrowserVersion = version;
  }
}

function failure(id: string, error: unknown): Response {
  return { id, ok: false, error: serializeError(error) };
}

/**
 * True when something accepts connections on the endpoint. A refused or
 * missing socket is stale; a connection that neither succeeds nor fails
 * within the timeout is treated as alive so a live daemon is never unlinked.
 */
function endpointAlive(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Run the daemon in the foreground of this process until it stops. */
export async function runDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const daemon = new Daemon(options);
  await daemon.start();
  const shutdown = (signal: string) => {
    void daemon.stop(`signal ${signal}`).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return daemon;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runDaemon().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
