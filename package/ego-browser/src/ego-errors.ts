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
    "  const task = await claimTaskSpace(spaceId)",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
  ].join("\n"),
  EGO_TASK_SPACE_USER_IN_CONTROL: [
    "The user has taken control of this task space, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around — do not retry and do not take control back on your own.",
    "Wait until the user explicitly asks you to continue, then take control back and resume:",
    "  const task = await takeOverTaskSpace(spaceId)",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`,
  ].join("\n"),
};

const USER_CONTROL_GUIDANCE =
  EGO_ERROR_MESSAGES.EGO_TASK_SPACE_USER_IN_CONTROL as string;

const USER_CONTROL_REASON_MESSAGES = Object.freeze({
  notifications: permissionPrompt("notifications"),
  location: permissionPrompt("location access"),
  camera: permissionPrompt("camera access"),
  microphone: permissionPrompt("microphone access"),
  pan_tilt_zoom_microphone: permissionPrompt(
    "camera control and microphone access",
  ),
  midi: permissionPrompt("MIDI device access"),
  bluetooth: userPromptGuidance(
    "A browser device chooser for Bluetooth has appeared.",
  ),
  usb: userPromptGuidance("A browser device chooser for USB has appeared."),
  serial: userPromptGuidance(
    "A browser port chooser for serial access has appeared.",
  ),
  hid: userPromptGuidance("A browser device chooser for HID has appeared."),
  protocol_handler: permissionPrompt("protocol handler registration"),
  manual_takeover: USER_CONTROL_GUIDANCE,
});

function permissionPrompt(access: string): string {
  return userPromptGuidance(
    `A browser permission prompt for ${access} has appeared.`,
  );
}

function userPromptGuidance(firstLine: string): string {
  return [
    firstLine,
    "The user now controls this task space. Wait for the user to handle the prompt.",
    "Resume only after the user confirms, using takeOverTaskSpace(spaceId).",
  ].join("\n");
}

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
    (code === "EGO_TASK_SPACE_USER_IN_CONTROL"
      ? resolveUserControlMessage(err)
      : isEgoErrorCode(code)
        ? EGO_ERROR_MESSAGES[code]
        : undefined) ??
    nativeErrorText(err) ??
    code ??
    "Unknown ego error";
  return { code, message };
}

function resolveUserControlMessage(err: unknown): string {
  const nativeText = nativeErrorText(err);
  if (nativeText && Object.hasOwn(USER_CONTROL_REASON_MESSAGES, nativeText)) {
    return USER_CONTROL_REASON_MESSAGES[
      nativeText as keyof typeof USER_CONTROL_REASON_MESSAGES
    ];
  }
  return USER_CONTROL_GUIDANCE;
}

/** Whether an ego error means the task is currently under user control. */
export function isEgoUserControlError(err: unknown): boolean {
  return egoErrorCode(err) === "EGO_TASK_SPACE_USER_IN_CONTROL";
}

/**
 * Probe control without turning the expected user-control response into a hard
 * stop. Ego bindings can report failures either by rejecting or by resolving an
 * `{ error, error_code }` object, so both paths must be inspected here.
 */
export async function probeAgentControl(
  invokeSnapshot: () => unknown | Promise<unknown>,
): Promise<boolean> {
  let result: unknown;
  try {
    result = await invokeSnapshot();
  } catch (error) {
    if (isEgoUserControlError(error)) return false;
    throw error;
  }
  if (isResolvedEgoError(result)) {
    if (isEgoUserControlError(result)) return false;
    throw buildEgoError(result);
  }
  return true;
}

function isResolvedEgoError(
  value: unknown,
): value is { error: unknown; error_code?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    (value as { error?: unknown }).error != null
  );
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

/**
 * Build an Error carrying the resolved message and stable error_code from any ego
 * error shape. `op`, when given, prefixes the message with the failing operation.
 * Shared by invokeEgo and the CDP-send failure path so every ego failure surfaces
 * an identical Error shape.
 */
export function buildEgoError(
  err: unknown,
  op?: string,
): Error & { error_code?: string } {
  const { code, message } = resolveEgoError(err);
  if (isEgoHardStopCode(code)) {
    // buildEgoError is the single birthplace of every ego error — invokeEgo and the
    // CDP-send failure path both route through it — so recording the hard stop here
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

/**
 * Invoke a native binding and normalize synchronous throws, rejected Promises, and
 * resolved `{ error, error_code }` objects. Control-wait probes intentionally bypass
 * this helper because observing user control is their expected result, not a hard stop.
 */
export async function invokeEgo<T>(
  op: string,
  invoke: () => T | Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    throw buildEgoError(error, op);
  }
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
