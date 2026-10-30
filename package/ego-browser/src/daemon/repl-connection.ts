// One `ego-browser nodejs` REPL process, driven through a pseudo-terminal.
//
// The CLI only enters REPL mode when stdin is a TTY, reads cells line by line
// with `std::cin.getline`, and never switches the terminal to raw mode. The
// pty therefore has to be put into raw mode by us (`stty raw -echo` before
// exec on POSIX): in canonical mode the line discipline drops any input line
// longer than MAX_CANON (1024 bytes on macOS), and echo would mix our own
// program text into the output we parse.
import { ErrorCodes, ProtocolError } from "./protocol.js";
import { extractResult, type ResultEnvelope } from "./program.js";

export type ReplTransport = {
  pid: number | null;
  write(data: string): void;
  kill(): void;
  onData(listener: (chunk: string) => void): void;
  onExit(
    listener: (info: {
      exitCode: number | null;
      signal?: number | string | null;
    }) => void,
  ): void;
};

export type SpawnReplOptions = {
  /** The `ego-browser` executable; resolved through PATH when not absolute. */
  bin: string;
  /** Arguments after `nodejs`, such as `--sdk-path <file>`. */
  nodejsArgs?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

/** Spawn the REPL under node-pty. Throws a clear error when node-pty is missing. */
export async function spawnReplTransport(
  options: SpawnReplOptions,
): Promise<ReplTransport> {
  let pty: any;
  try {
    pty = await import("node-pty");
  } catch (error) {
    throw new ProtocolError(
      ErrorCodes.SESSION_START_FAILED,
      `node-pty is not installed (${(error as Error).message}); reinstall the ego-run package`,
    );
  }
  const args = ["nodejs", ...(options.nodejsArgs ?? [])];
  const env = { ...(options.env ?? process.env), TERM: "dumb" };
  const spawnOptions = {
    name: "dumb",
    cols: 500,
    rows: 50,
    cwd: options.cwd ?? process.cwd(),
    env,
  };
  const child =
    process.platform === "win32"
      ? pty.spawn(options.bin, args, spawnOptions)
      : pty.spawn(
          "/bin/sh",
          [
            "-c",
            'stty raw -echo 2>/dev/null; exec "$0" "$@"',
            options.bin,
            ...args,
          ],
          spawnOptions,
        );
  return {
    pid: child.pid ?? null,
    write: (data) => child.write(data),
    kill: () => {
      try {
        child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {
        // already gone
      }
    },
    onData: (listener) => child.onData(listener),
    onExit: (listener) => child.onExit(listener),
  };
}

export type ExecOutcome = {
  envelope: ResultEnvelope;
  /** Text the REPL printed around the result line, prompts removed. */
  stray: string;
};

const BANNER_TIMEOUT_MS = 20_000;
/** Extra time past the program's own deadline before the REPL counts as hung. */
const HUNG_GRACE_MS = 5_000;

export class ReplConnection {
  readonly transport: ReplTransport;
  evaluations = 0;
  alive = true;
  exitInfo: {
    exitCode: number | null;
    signal?: number | string | null;
  } | null = null;
  #output = "";
  #waiters = new Set<() => void>();
  #exitListeners = new Set<() => void>();

  constructor(transport: ReplTransport) {
    this.transport = transport;
    transport.onData((chunk) => {
      this.#output += chunk;
      for (const wake of this.#waiters) wake();
    });
    transport.onExit((info) => {
      this.alive = false;
      this.exitInfo = info;
      for (const wake of this.#waiters) wake();
      for (const listener of this.#exitListeners) listener();
    });
  }

  get pid() {
    return this.transport.pid;
  }

  onExit(listener: () => void) {
    this.#exitListeners.add(listener);
  }

  /** Resolve once the REPL prints its banner; reject when the CLI exits first. */
  async waitForBanner(timeoutMs: number = BANNER_TIMEOUT_MS): Promise<void> {
    const ready = () => /ego-browser nodejs REPL|repl> /.test(this.#output);
    // An early exit must not wait out the banner timeout.
    await this.#waitUntil(() => ready() || !this.alive, timeoutMs);
    if (!this.alive) {
      throw new ProtocolError(
        ErrorCodes.SESSION_START_FAILED,
        `ego-browser nodejs exited before entering the REPL (code ${this.exitInfo?.exitCode}): ${this.#stray().trim() || "no output"}`,
      );
    }
    if (!ready()) {
      throw new ProtocolError(
        ErrorCodes.SESSION_START_FAILED,
        `ego-browser nodejs did not enter the REPL within ${timeoutMs} ms: ${this.#stray().trim() || "no output"}`,
      );
    }
    this.#output = "";
  }

  /**
   * Send one wrapped cell and wait for its result line. Rejects with
   * SESSION_LOST when the REPL exits, and HUNG when the deadline passes without
   * a result (an event-loop-blocking program), in which case the caller must
   * kill and rebuild the session.
   */
  async exec(
    cell: string,
    requestId: string,
    timeoutMs: number,
  ): Promise<ExecOutcome> {
    if (!this.alive) {
      throw new ProtocolError(
        ErrorCodes.SESSION_LOST,
        "the REPL process is gone",
      );
    }
    this.#output = "";
    this.transport.write(`.cell\n${cell}\n.end\n`);
    this.evaluations += 1;
    let found: ReturnType<typeof extractResult> = null;
    const done = () => {
      found = extractResult(this.#output, requestId);
      return found !== null || !this.alive || /^Uncaught /m.test(this.#output);
    };
    await this.#waitUntil(done, timeoutMs + HUNG_GRACE_MS);
    if (found) {
      const { envelope, rest } = found;
      this.#output = "";
      return { envelope, stray: cleanStray(rest) };
    }
    const stray = this.#stray().trim();
    this.#output = "";
    if (!this.alive) {
      throw new ProtocolError(
        ErrorCodes.SESSION_LOST,
        `the REPL process exited while running the program (code ${this.exitInfo?.exitCode})${stray ? `: ${stray}` : ""}`,
      );
    }
    if (/^Uncaught /m.test(stray)) {
      throw new ProtocolError(
        ErrorCodes.SESSION_LOST,
        `the REPL rejected the program: ${stray}`,
      );
    }
    throw new ProtocolError(
      ErrorCodes.HUNG,
      `no result after ${timeoutMs + HUNG_GRACE_MS} ms; the program is blocking the event loop, so the session will be rebuilt${stray ? `; output so far: ${stray}` : ""}`,
    );
  }

  kill() {
    this.alive = false;
    this.transport.kill();
  }

  #stray() {
    return cleanStray(this.#output);
  }

  #waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      const wake = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      timer = setTimeout(() => {
        this.#waiters.delete(wake);
        resolve();
      }, timeoutMs);
      this.#waiters.add(wake);
    });
  }
}

function cleanStray(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^(repl> )+/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
}
