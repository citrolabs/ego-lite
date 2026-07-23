/**
 * Stable ego error codes and helpers for the Linux host.
 *
 * Code list mirrors package/ego-browser/src/ego-errors.ts (copied, not imported,
 * to avoid cross-package coupling until a shared module exists).
 */

/** Stable error codes emitted by ego bindings / host. */
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

/** Type guard for codes this build knows about. */
export function isEgoErrorCode(value: unknown): value is EgoErrorCode {
  return (
    typeof value === "string" &&
    (EGO_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Build a thrown Error carrying a stable `error_code`.
 * Alias: `egoError` (interface name from the plan).
 */
export function makeEgoError(
  code: string,
  message: string,
): Error & { error_code: string } {
  const err = new Error(message) as Error & { error_code: string };
  err.error_code = code;
  return err;
}

/** Plan interface name — same as makeEgoError. */
export const egoError = makeEgoError;

/** Resolved-result error shape `{ error, error_code }` (not thrown). */
export function egoResultError(code: string, message: string) {
  return { error: message, error_code: code };
}

/**
 * Whether a code means the user currently controls the task space
 * (agent must not drive page ops until takeOver/claim).
 */
export function isUserControlCode(code: string): boolean {
  return code === "EGO_TASK_SPACE_USER_IN_CONTROL";
}
