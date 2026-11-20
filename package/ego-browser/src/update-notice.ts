import { setTimeout as delay } from "node:timers/promises";

const PROBE_TIMEOUT_MS = 500;

type BrowserVersionRuntime = {
  getBrowserVersion?: () => unknown | Promise<unknown>;
};

/** Emit a best-effort update hint without making it part of task success. */
export async function emitUpdateNotice(
  runtime: BrowserVersionRuntime | null | undefined,
  emit: (line: string) => void,
): Promise<void> {
  if (typeof runtime?.getBrowserVersion !== "function") return;

  try {
    const result = await Promise.race([
      runtime.getBrowserVersion(),
      delay(PROBE_TIMEOUT_MS, null, { ref: false }),
    ]);
    if (!result || typeof result !== "object") return;
    const info = result as Record<string, unknown>;
    if (
      info.updateAvailable !== true ||
      typeof info.currentVersion !== "string" ||
      info.currentVersion.trim().length === 0
    ) {
      return;
    }
    emit(
      `[ego-browser:notice] Ego Lite update is available ` +
        `(current ${info.currentVersion.trim()}). Finish the current browser task, ` +
        "then ask the user before running `ego-browser upgrade`; re-read the " +
        "ego-browser Skill afterward.",
    );
  } catch {
    // An optional update hint must never fail the browser task.
  }
}
