// The JSON-lines protocol between `ego-run` (thin CLI) and the daemon.
//
// One request per connection: the client sends a single line and reads a
// single line back. Every request carries the protocol version and the
// shared-secret token from the state directory.

/** Bump when a request or response field changes meaning. */
export const PROTOCOL_VERSION = 1;

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 180_000;
export const MAX_ACTIVE_SESSIONS = 8;
export const SESSION_IDLE_MS = 10 * 60_000;
export const DAEMON_IDLE_MS = 30 * 60_000;
/** Results above this size are written to a file instead of returned inline. */
export const INLINE_RESULT_LIMIT = 1_000_000;

export const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Request ids name spill files and result markers: no separators or quotes. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

export type ExecRequest = {
  cmd: "exec";
  session: string;
  program: string;
  timeoutMs?: number;
  /** `ego-browser nodejs --sdk-path`; fixed when the session is created. */
  sdkPath?: string;
};

export type SessionNewRequest = { cmd: "session.new"; prefix?: string };
export type SessionListRequest = { cmd: "session.list" };
export type SessionCloseRequest = {
  cmd: "session.close";
  session?: string;
  all?: boolean;
};
export type SessionResetRequest = { cmd: "session.reset"; session: string };
export type StatusRequest = { cmd: "status" };
export type ShutdownRequest = { cmd: "shutdown" };

export type Request = (
  | ExecRequest
  | SessionNewRequest
  | SessionListRequest
  | SessionCloseRequest
  | SessionResetRequest
  | StatusRequest
  | ShutdownRequest
) & { v: number; token: string; id?: string };

export type SessionInfo = {
  session: string;
  backend: "repl";
  pid: number | null;
  evaluations: number;
  createdAt: string;
  idleMs: number;
  rebuilt: number;
  busy: boolean;
  queued: number;
  sdkPath: string | null;
};

export type ExecResponse = {
  id: string;
  ok: boolean;
  /** JSON value of the program's last expression / `return`, or undefined. */
  value?: unknown;
  /** Absolute path of the spilled result when it exceeded the inline limit. */
  valueFile?: string;
  /** Absolute path of the full output when the logs exceeded the limit. */
  logsFile?: string;
  /** Everything the program logged (console.*, cliLog, help(), notices). */
  logs: string;
  error?: SerializedError;
  /** Browser-side time of the program itself. */
  ms: number;
  /** Time spent waiting for the session's queue. */
  queueMs: number;
  persistent: true;
  session: {
    id: string;
    /** True when this request created or rebuilt the context. */
    fresh: boolean;
    rebuiltReason?: string;
    evaluations: number;
    pid: number | null;
  };
  /** Text the REPL printed outside the result envelope (diagnostics only). */
  stray?: string;
};

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
};

export type ErrorResponse = {
  id: string;
  ok: false;
  error: SerializedError;
};

export type Response =
  | ExecResponse
  | ErrorResponse
  | { id: string; ok: true; [key: string]: unknown };

export const ErrorCodes = {
  VERSION_MISMATCH: "EGO_RUN_VERSION_MISMATCH",
  UNAUTHORIZED: "EGO_RUN_UNAUTHORIZED",
  BAD_REQUEST: "EGO_RUN_BAD_REQUEST",
  DEADLINE: "EGO_RUN_DEADLINE",
  HUNG: "EGO_RUN_HUNG",
  SESSION_START_FAILED: "EGO_RUN_SESSION_START_FAILED",
  SESSION_LOST: "EGO_RUN_SESSION_LOST",
  SESSION_SDK_MISMATCH: "EGO_RUN_SESSION_SDK_MISMATCH",
  DAEMON_UNAVAILABLE: "EGO_RUN_DAEMON_UNAVAILABLE",
  PROGRAM_SYNTAX: "EGO_RUN_PROGRAM_SYNTAX",
} as const;

export class ProtocolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error && typeof error === "object") {
    const e = error as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      code?: unknown;
    };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : String(error),
      stack: typeof e.stack === "string" ? e.stack : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
    };
  }
  return { name: "Error", message: String(error) };
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}

export function isValidRequestId(id: unknown): id is string {
  return typeof id === "string" && REQUEST_ID_PATTERN.test(id);
}

export function clampTimeout(value: unknown): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, n));
}
