/**
 * Shared handling for `{ error: ... }` result objects returned by ego bindings.
 * Single source of truth — previously duplicated in helpers.ts and driver/nav.ts.
 */

export function assertNoEgoError(result, op: string) {
  if (result && typeof result === "object" && "error" in result && result.error != null) {
    throw new Error(`${op}: ${formatEgoError(result.error)}`);
  }
  return result;
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
