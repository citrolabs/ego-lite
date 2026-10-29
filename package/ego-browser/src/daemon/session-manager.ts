// Sessions: one REPL connection per agent-chosen session id, programs on the
// same session run one at a time, different sessions run in parallel.
import { randomBytes } from "node:crypto";

import {
  ErrorCodes,
  MAX_ACTIVE_SESSIONS,
  ProtocolError,
  SESSION_IDLE_MS,
  INLINE_RESULT_LIMIT,
  clampTimeout,
  isValidSessionId,
  serializeError,
  type ExecRequest,
  type ExecResponse,
  type SessionInfo,
} from "./protocol.js";
import { rewriteProgram, wrapProgram } from "./program.js";
import {
  ReplConnection,
  spawnReplTransport,
  type SpawnReplOptions,
} from "./repl-connection.js";

export type SessionManagerOptions = {
  /** `ego-browser` executable used for every REPL. */
  bin: string;
  spillDir: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  maxSessions?: number;
  idleMs?: number;
  inlineLimit?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** Test seam: build a connection without a real pty. */
  connect?: (options: SpawnReplOptions) => Promise<ReplConnection>;
};

class Session {
  readonly id: string;
  readonly createdAt: number;
  sdkPath: string | null;
  connection: ReplConnection | null = null;
  lastUsed: number;
  evaluations = 0;
  rebuilt = 0;
  /** Why the next program will get a fresh context. */
  pendingReason: string | null = "new session";
  busy = false;
  queued = 0;
  /** Set by close(): queued programs must fail instead of reopening a REPL. */
  closed = false;
  chain: Promise<unknown> = Promise.resolve();

  constructor(id: string, sdkPath: string | null, now: number) {
    this.id = id;
    this.sdkPath = sdkPath;
    this.createdAt = now;
    this.lastUsed = now;
  }
}

export class SessionManager {
  readonly #options: Required<
    Pick<
      SessionManagerOptions,
      "bin" | "spillDir" | "maxSessions" | "idleMs" | "inlineLimit"
    >
  > &
    SessionManagerOptions;
  readonly #sessions = new Map<string, Session>();
  #requestSeq = 0;

  constructor(options: SessionManagerOptions) {
    this.#options = {
      maxSessions: MAX_ACTIVE_SESSIONS,
      idleMs: SESSION_IDLE_MS,
      inlineLimit: INLINE_RESULT_LIMIT,
      ...options,
    };
  }

  get size() {
    return this.#sessions.size;
  }

  #now() {
    return this.#options.now ? this.#options.now() : Date.now();
  }

  #log(line: string) {
    this.#options.log?.(line);
  }

  newId(prefix = "session"): string {
    const base =
      prefix
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "session";
    for (;;) {
      const id = `${base.slice(0, 56)}-${randomBytes(3).toString("hex")}`;
      if (!this.#sessions.has(id)) return id;
    }
  }

  async exec(
    request: ExecRequest,
    requestId = `req-${++this.#requestSeq}`,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ExecResponse> {
    if (!isValidSessionId(request.session)) {
      throw new ProtocolError(
        ErrorCodes.BAD_REQUEST,
        `invalid session id ${JSON.stringify(request.session)}: use 1-64 characters of [a-z0-9-], starting with a letter or digit`,
      );
    }
    if (typeof request.program !== "string") {
      throw new ProtocolError(
        ErrorCodes.BAD_REQUEST,
        "program must be a string",
      );
    }
    const timeoutMs = clampTimeout(request.timeoutMs);
    const sdkPath = request.sdkPath || null;
    // Parse before touching the session so a syntax error never costs a REPL.
    const rewritten = rewriteProgram(request.program);
    const session = this.#acquire(request.session, sdkPath);
    if (session.sdkPath !== sdkPath) {
      throw new ProtocolError(
        ErrorCodes.SESSION_SDK_MISMATCH,
        `session ${session.id} was created with --sdk-path ${session.sdkPath ?? "(none)"}; close it first or use another session id`,
      );
    }
    const queuedAt = this.#now();
    session.queued += 1;
    const run = async (): Promise<ExecResponse> => {
      session.queued -= 1;
      session.busy = true;
      const queueMs = this.#now() - queuedAt;
      try {
        this.#assertOpen(session);
        // The client is gone: nobody would see the result, and a program that
        // runs unseen still mutates the context. Skip it; the session is intact.
        if (signal?.aborted) {
          throw new ProtocolError(
            ErrorCodes.BAD_REQUEST,
            `client disconnected after waiting ${queueMs} ms for session ${session.id}; the program did not start`,
          );
        }
        // Queue time counts against the deadline, so the client never waits
        // longer than its own timeout for a program that has not started.
        const remainingMs = timeoutMs - queueMs;
        if (remainingMs <= 0) {
          throw new ProtocolError(
            ErrorCodes.DEADLINE,
            `the ${timeoutMs} ms deadline passed while waiting ${queueMs} ms for session ${session.id}; the program did not start`,
          );
        }
        let fresh = false;
        let rebuiltReason: string | undefined;
        if (!session.connection) {
          fresh = true;
          rebuiltReason = session.pendingReason ?? undefined;
          await this.#open(session);
          if (session.closed) {
            // close() ran while the REPL was starting: do not leave it behind.
            this.#discard(session, "closed");
            this.#assertOpen(session);
          }
        }
        const connection = session.connection!;
        const cell = wrapProgram(rewritten, {
          requestId,
          timeoutMs: remainingMs,
          spillDir: this.#options.spillDir,
          inlineLimit: this.#options.inlineLimit,
        });
        const started = this.#now();
        let outcome;
        try {
          outcome = await connection.exec(cell, requestId, remainingMs);
        } catch (error) {
          const code = (error as ProtocolError).code;
          this.#discard(
            session,
            code === ErrorCodes.HUNG ? "program hung" : "REPL exited",
          );
          throw error;
        }
        session.evaluations += 1;
        session.lastUsed = this.#now();
        const { envelope } = outcome;
        if (!envelope.ok && envelope.error?.code === ErrorCodes.DEADLINE) {
          // The deadline only returned early; the program is still running in
          // the context, so it cannot be shared with the next one.
          this.#discard(session, "deadline exceeded");
        }
        this.#log(
          `exec ${requestId} session=${session.id} ok=${envelope.ok} queue=${queueMs}ms browser=${Math.round(envelope.ms)}ms wall=${this.#now() - started}ms`,
        );
        const response: ExecResponse = {
          id: requestId,
          ok: envelope.ok,
          value: envelope.value,
          valueFile: envelope.valueFile,
          logsFile: envelope.logsFile,
          logs: envelope.logs ?? "",
          error: envelope.error,
          ms: envelope.ms,
          queueMs,
          persistent: true,
          session: {
            id: session.id,
            fresh,
            rebuiltReason:
              fresh && session.rebuilt > 0 ? rebuiltReason : undefined,
            evaluations: session.evaluations,
            pid: connection.pid,
          },
          stray: outcome.stray || undefined,
        };
        return response;
      } finally {
        session.busy = false;
        session.lastUsed = this.#now();
      }
    };
    const result = session.chain.then(run, run);
    session.chain = result.catch(() => {});
    return result;
  }

  #assertOpen(session: Session) {
    if (session.closed) {
      throw new ProtocolError(
        ErrorCodes.SESSION_LOST,
        `session ${session.id} was closed while this program was queued`,
      );
    }
  }

  #acquire(id: string, sdkPath: string | null): Session {
    let session = this.#sessions.get(id);
    if (session) return session;
    if (this.#sessions.size >= this.#options.maxSessions) {
      const victim = [...this.#sessions.values()]
        .filter((s) => !s.busy && s.queued === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) {
        throw new ProtocolError(
          ErrorCodes.BAD_REQUEST,
          `all ${this.#options.maxSessions} sessions are busy; close one with "ego-run session close <id>"`,
        );
      }
      this.#log(`evict ${victim.id} (least recently used)`);
      this.close(victim.id);
    }
    session = new Session(id, sdkPath, this.#now());
    this.#sessions.set(id, session);
    return session;
  }

  async #open(session: Session): Promise<void> {
    const spawnOptions: SpawnReplOptions = {
      bin: this.#options.bin,
      nodejsArgs: session.sdkPath ? ["--sdk-path", session.sdkPath] : [],
      env: this.#options.env,
      cwd: this.#options.cwd,
    };
    const connect =
      this.#options.connect ??
      (async (options: SpawnReplOptions) =>
        new ReplConnection(await spawnReplTransport(options)));
    const started = this.#now();
    let connection: ReplConnection;
    try {
      connection = await connect(spawnOptions);
      await connection.waitForBanner();
    } catch (error) {
      this.#log(`open ${session.id} failed: ${(error as Error).message}`);
      throw error instanceof ProtocolError
        ? error
        : new ProtocolError(
            ErrorCodes.SESSION_START_FAILED,
            (error as Error).message,
          );
    }
    connection.onExit(() => {
      if (session.connection === connection) {
        this.#discard(session, "REPL exited");
      }
    });
    if (session.pendingReason !== "new session") session.rebuilt += 1;
    session.connection = connection;
    session.pendingReason = null;
    this.#log(
      `open ${session.id} pid=${connection.pid} in ${this.#now() - started}ms`,
    );
  }

  /** Drop the REPL so the next program gets a fresh context. */
  #discard(session: Session, reason: string) {
    const connection = session.connection;
    session.connection = null;
    session.pendingReason = reason;
    if (connection) {
      this.#log(`discard ${session.id} pid=${connection.pid}: ${reason}`);
      connection.kill();
    }
  }

  list(): SessionInfo[] {
    const now = this.#now();
    return [...this.#sessions.values()].map((s) => ({
      session: s.id,
      backend: "repl" as const,
      pid: s.connection?.pid ?? null,
      evaluations: s.evaluations,
      createdAt: new Date(s.createdAt).toISOString(),
      idleMs: now - s.lastUsed,
      rebuilt: s.rebuilt,
      busy: s.busy,
      queued: s.queued,
      sdkPath: s.sdkPath,
    }));
  }

  has(id: string) {
    return this.#sessions.has(id);
  }

  close(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#sessions.delete(id);
    session.closed = true;
    this.#discard(session, "closed");
    return true;
  }

  closeAll(reason = "closed"): number {
    let count = 0;
    for (const id of [...this.#sessions.keys()]) {
      const session = this.#sessions.get(id)!;
      this.#sessions.delete(id);
      session.closed = true;
      this.#discard(session, reason);
      count += 1;
    }
    return count;
  }

  /** Keep the session id, drop its context. */
  reset(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    this.#discard(session, "reset");
    return true;
  }

  /** Close sessions idle for longer than the limit; returns how many. */
  sweep(): number {
    const now = this.#now();
    let closed = 0;
    for (const session of [...this.#sessions.values()]) {
      if (
        !session.busy &&
        session.queued === 0 &&
        now - session.lastUsed > this.#options.idleMs
      ) {
        this.#log(
          `idle ${session.id} for ${Math.round((now - session.lastUsed) / 1000)}s`,
        );
        this.close(session.id);
        closed += 1;
      }
    }
    return closed;
  }
}

export { serializeError };
