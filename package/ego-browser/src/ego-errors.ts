/**
 * Shared handling for ego-binding errors.
 *
 * Browser-side failures expose two signals (see the EgoBindings JS API):
 *   - human-readable text (`error` on resolved results, `message` on rejected
 *     Errors), and
 *   - a stable `error_code` such as EGO_TASK_SPACE_USER_IN_CONTROL.
 *
 * The code is the durable contract; the wording can drift between builds. Branch
 * on the code (isEgoUserControlError), not on the message. EGO_ERROR_MESSAGES is
 * where ego-browser owns its wording for the few codes an agent must act on; every
 * other code (and any unknown future code) defers to the native error message.
 *
 * Single source of truth — error handling was previously duplicated across
 * helpers.ts and driver/nav.ts.
 */

import { markHardStop } from "./output-sink.js";

/** Error kind classification for retry logic. */
export type ErrorKind = "transient" | "permanent";

/**
 * Structured error base class with recovery guidance.
 * All ego-browser errors extend this for consistent handling.
 */
export class EgoError extends Error {
  kind: ErrorKind;
  code: string;
  context: {
    url?: string;
    ref?: string;
    timestamp: number;
    sessionId?: string;
  };
  recoveryHint?: string;

  constructor(
    message: string,
    kind: ErrorKind,
    code: string,
    context?: Partial<EgoError["context"]>,
    recoveryHint?: string,
  ) {
    super(message);
    this.name = "EgoError";
    this.kind = kind;
    this.code = code;
    this.context = {
      timestamp: Date.now(),
      ...context,
      ...(context?.url ? { url: redactUrl(context.url) } : {}),
    };
    this.recoveryHint = recoveryHint;
  }

  /** Serialize to JSON-safe object for logging. */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      code: this.code,
      context: { ...this.context },
      recoveryHint: this.recoveryHint,
    };
  }
}

/** Element not found or stale reference. */
export class ElementResolutionError extends EgoError {
  constructor(message: string, kind: ErrorKind = "transient") {
    super(
      message,
      kind,
      "ELEMENT_NOT_FOUND",
      undefined,
      kind === "transient"
        ? "Element may not have loaded yet. Try waiting with waitForSelector or re-snapshot the page."
        : "Element not found — check the selector or page state.",
    );
    this.name = "ElementResolutionError";
  }
}

/** Page navigation timed out. */
/** Redact query params and fragments from a URL for safe message display. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // Not a valid URL — strip everything after the first '?' or '#'
    return url.split(/[?#]/)[0];
  }
}

export class NavigationTimeoutError extends EgoError {
  constructor(url: string, timeoutMs: number) {
    super(
      `Navigation to ${redactUrl(url)} timed out after ${timeoutMs}ms`,
      "transient",
      "NAVIGATION_TIMEOUT",
      { url },
      "Page may be slow to load. Try increasing timeout or using waitForLoadState with 'networkidle'.",
    );
    this.name = "NavigationTimeoutError";
  }
}

/** Native dialog blocking JavaScript execution. */
export class DialogBlockingError extends EgoError {
  constructor(dialogType: string) {
    super(
      `Native ${dialogType} dialog is blocking page JavaScript`,
      "transient",
      "DIALOG_BLOCKING",
      undefined,
      "Handle the dialog with cdp('Page.handleJavaScriptDialog', {accept: true}) before continuing.",
    );
    this.name = "DialogBlockingError";
  }
}

/** CDP connection lost during operation. */
export class TimeoutError extends EgoError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `${operation} timed out after ${timeoutMs}ms`,
      "transient",
      "TIMEOUT",
      undefined,
      `Increase the timeout for ${operation} or investigate why it is slow.`,
    );
    this.name = "TimeoutError";
  }
}

export class ConnectionLostError extends EgoError {
  constructor(previousUrl?: string) {
    super(
      "CDP connection lost during operation",
      "transient",
      "CONNECTION_LOST",
      { url: previousUrl },
      "Attempting automatic reconnect. Retry the operation if it fails again.",
    );
    this.name = "ConnectionLostError";
  }
}

export type CdpErrorContext = {
  operation: string;
  url?: string;
  timeoutMs?: number;
  sessionId?: string;
};

type CdpMappedError = Error & { code?: string };

type ErrorTaxonomyOverrides = {
  mapCdpError?: (rawError: unknown, context: CdpErrorContext) => CdpMappedError;
  navigationTimeout?: (url: string, timeoutMs: number) => Error;
  connectionFailure?: (previousUrl?: string) => Error;
  operationTimeout?: (operation: string, timeoutMs: number) => Error;
};

const SESSION_LOST_MESSAGE =
  /Session (?:with given id )?not found|Target closed|No session/i;
const TIMEOUT_MESSAGE = /timed? out|timeout/i;

const defaultErrorTaxonomy = {
  navigationTimeout: (url: string, timeoutMs: number): Error =>
    new NavigationTimeoutError(url, timeoutMs),
  connectionFailure: (previousUrl?: string): Error =>
    new ConnectionLostError(previousUrl),
  operationTimeout: (operation: string, timeoutMs: number): Error =>
    new TimeoutError(operation, timeoutMs),
};

let errorTaxonomyOverrides: ErrorTaxonomyOverrides = {};

function rawErrorMessage(rawError: unknown): string {
  if (rawError instanceof Error) return rawError.message;
  return formatEgoError(rawError);
}

/** Convert a raw CDP rejection into the structured taxonomy. */
export function mapCdpError(
  rawError: unknown,
  context: CdpErrorContext,
): CdpMappedError {
  if (errorTaxonomyOverrides.mapCdpError) {
    return errorTaxonomyOverrides.mapCdpError(rawError, context);
  }
  if (rawError instanceof EgoError) return rawError;
  if (rawError instanceof Error && "error_code" in rawError) {
    return rawError as CdpMappedError;
  }

  const message = rawErrorMessage(rawError);
  if (SESSION_LOST_MESSAGE.test(message)) {
    return createConnectionLostError(context.url);
  }
  if (TIMEOUT_MESSAGE.test(message) && context.operation === "navigate") {
    return createNavigationTimeoutError(context.url ?? "", context.timeoutMs ?? 0);
  }
  if (TIMEOUT_MESSAGE.test(message)) {
    return createOperationTimeoutError(context.operation, context.timeoutMs ?? 0);
  }
  return new EgoError(message, "permanent", "CDP_ERROR", {
    url: context.url,
    sessionId: context.sessionId,
  });
}

export function createNavigationTimeoutError(url: string, timeoutMs: number) {
  return (
    errorTaxonomyOverrides.navigationTimeout ??
    defaultErrorTaxonomy.navigationTimeout
  )(url, timeoutMs);
}

export function createConnectionLostError(previousUrl?: string) {
  return (
    errorTaxonomyOverrides.connectionFailure ??
    defaultErrorTaxonomy.connectionFailure
  )(previousUrl);
}

export function createOperationTimeoutError(
  operation: string,
  timeoutMs: number,
) {
  return (
    errorTaxonomyOverrides.operationTimeout ??
    defaultErrorTaxonomy.operationTimeout
  )(operation, timeoutMs);
}

/** Install isolated taxonomy mutations for executable wiring checks. */
export function setErrorTaxonomyOverrides(overrides: ErrorTaxonomyOverrides) {
  const previous = errorTaxonomyOverrides;
  errorTaxonomyOverrides = { ...previous, ...overrides };
  return () => {
    errorTaxonomyOverrides = previous;
  };
}

/** Stable error codes emitted by the native ego bindings. */
export const EGO_ERROR_CODES = [
  "EGO_BROWSER_UNAVAILABLE",
  "EGO_CDP_CHANNEL_UNAVAILABLE",
  "EGO_CDP_SEND_FAILED",
  "EGO_INVALID_ARGUMENT",
  "EGO_INVALID_RESULT_PAYLOAD",
  "EGO_OPERATION_FAILED",
  "EGO_RESULT_CONVERSION_FAILED",
  "EGO_SNAPSHOT_FAILED",
  "EGO_TASK_HOST_DISCONNECTED",
  "EGO_TASK_SPACE_INACTIVE",
  "EGO_TASK_SPACE_NOT_FOUND",
  "EGO_TASK_SPACE_NOT_SELECTED",
  "EGO_TASK_SPACE_UNAVAILABLE",
  "EGO_TASK_SPACE_USER_IN_CONTROL",
  "EGO_WEB_CONTENTS_UNAVAILABLE",
] as const;

export type EgoErrorCode = (typeof EGO_ERROR_CODES)[number];

/**
 * Codes whose wording ego-browser owns. A listed code returns this static, id-less
 * message instead of the native error message — reserved for the two business signals
 * an agent must react to, not just report. Every other code is absent here and defers
 * to the native error message (and any unknown future code does too), which is more
 * specific than any static line.
 */
const EGO_ERROR_MESSAGES: Partial<Record<EgoErrorCode, string>> = {
  EGO_TASK_SPACE_INACTIVE: [
    "The user has taken control of this task space and ended the task, so it is no longer assigned to the agent and browser commands are paused.",
    "This is a hard stop, not an obstacle to route around — do not retry and do not take ownership back on your own.",
    "Wait until the user explicitly asks you to continue, then claim the space and resume:",
    "  await taskSpaces.claim(id)",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
  ].join("\n"),
  EGO_TASK_SPACE_USER_IN_CONTROL: [
    "The user has taken control of this task space, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
    "Wait until the user explicitly asks you to continue, then take control back and resume:",
    "  await taskSpaces.takeOver()",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
  ].join("\n"),
};

/** Type guard for codes this build knows about. */
export function isEgoErrorCode(value: unknown): value is EgoErrorCode {
  return (
    typeof value === "string" &&
    (EGO_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Pull the stable error_code out of any ego error shape: resolved
 * `{ error, error_code }` objects, rejected/thrown Errors carrying `.error_code`,
 * or a bare known code string. Returns the raw code (which may be one this build
 * does not know about yet) or undefined when none is present.
 */
export function egoErrorCode(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? err : undefined;
  }
  if (err && typeof err === "object") {
    const code = (err as Record<string, unknown>).error_code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

/**
 * Resolve any ego error into a stable `{ code, message }` pair.
 *
 * For a code ego-browser owns wording for, `message` is that owned wording.
 * Otherwise (a code not owned here, or an unknown future code) it falls back to
 * the native error message the binding returned, then the bare code, then a
 * generic string. `code` is the stable classifier and may be undefined.
 */
export function resolveEgoError(err: unknown): {
  code?: string;
  message: string;
} {
  const code = egoErrorCode(err);
  const message =
    (isEgoErrorCode(code) ? EGO_ERROR_MESSAGES[code] : undefined) ??
    nativeErrorText(err) ??
    code ??
    "Unknown ego error";
  return { code, message };
}

/** Whether an ego error means the task is currently under user control. */
export function isEgoUserControlError(err: unknown): boolean {
  return egoErrorCode(err) === "EGO_TASK_SPACE_USER_IN_CONTROL";
}

/**
 * Codes that halt the whole agent task rather than mark a routable obstacle: a task
 * space the user has taken back, or one that is inactive / not assigned to this agent.
 * Both require the user to explicitly hand control back before work can resume.
 */
function isEgoHardStopCode(code: string | undefined): boolean {
  return (
    code === "EGO_TASK_SPACE_USER_IN_CONTROL" ||
    code === "EGO_TASK_SPACE_INACTIVE"
  );
}

/** Whether an ego error is a hard stop the agent must not retry or route around. */
export function isEgoHardStopError(err: unknown): boolean {
  return isEgoHardStopCode(egoErrorCode(err));
}

/**
 * Build an Error carrying the resolved message and stable error_code from any ego
 * error shape. `op`, when given, prefixes the message with the failing operation.
 * Shared by assertNoEgoError (which throws it) and the CDP-send failure path (which
 * rejects pending requests with it) so every ego failure surfaces an identical
 * Error shape.
 */
export function buildEgoError(
  err: unknown,
  op?: string,
): Error & { error_code?: string } {
  const { code, message } = resolveEgoError(err);
  if (isEgoHardStopCode(code)) {
    // buildEgoError is the single birthplace of every ego error — assertNoEgoError and
    // the CDP-send failure path both route through it — so recording the hard stop here
    // catches it even when the agent's own try/catch later swallows the thrown Error.
    // The op-less owned message is the one the agent should see, regardless of which
    // operation surfaced it.
    markHardStop(message);
  }
  const error: Error & { error_code?: string } = new Error(
    op ? `${op}: ${message}` : message,
  );
  if (code) error.error_code = code;
  return error;
}

export function assertNoEgoError(result, op?: string) {
  if (
    result &&
    typeof result === "object" &&
    "error" in result &&
    result.error != null
  ) {
    throw buildEgoError(result, op);
  }
  return result;
}

/**
 * The native error message from any ego error shape — the binding's runtime
 * `error`/`message` text (dynamic, may vary across builds). Ignores bare codes.
 */
function nativeErrorText(err: unknown): string | undefined {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? undefined : err;
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (obj.error != null) return formatEgoError(obj.error);
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return undefined;
}

export function formatEgoError(err: unknown): string {
  if (err == null) return String(err);
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
