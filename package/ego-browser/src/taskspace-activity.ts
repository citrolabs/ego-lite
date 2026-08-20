import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { resolvePath } from "./env.js";
import { state } from "./state.js";

/**
 * Idle task-space reclamation state.
 *
 * The ego-browser harness is a short-lived process (one Node invocation per
 * heredoc round), so it cannot keep task-space activity timestamps in memory.
 * Instead it persists `{ spaceId -> lastTouchedAtMs }` to a JSON file on disk.
 * `reclaimIdleTaskSpaces()` (see taskspace-reclaim.ts) reads this map on every
 * harness startup and closes agent-owned task spaces that have been idle longer
 * than the configured threshold, which lets the browser reclaim their renderer
 * processes. Only agent-owned spaces are touched; user tabs are never closed.
 *
 * Env overrides:
 *   EGO_RECLAIM_STATE_FILE  — absolute path to the state file (default
 *                             ~/.local/share/ego/reclaim-state.json)
 *   EGO_RECLAIM_IDLE_S      — idle threshold in seconds (default 7200 = 2h)
 *   EGO_RECLAIM_MAX_SPACES  — hard cap on live agent spaces (default 8)
 *   EGO_RECLAIM_DISABLE     — "1"/"true" disables reclamation entirely
 */
export type ActivityMap = Record<number, number>;

const DEFAULT_STATE_FILE = resolve(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".local/share/ego/reclaim-state.json",
);

export function reclaimStateFile(): string {
  const override = process.env.EGO_RECLAIM_STATE_FILE;
  return override ? resolvePath(override) : DEFAULT_STATE_FILE;
}

export function reclaimConfig() {
  return {
    idleSec: envInt("EGO_RECLAIM_IDLE_S", 7200),
    maxSpaces: envInt("EGO_RECLAIM_MAX_SPACES", 8),
    disabled: envFlag("EGO_RECLAIM_DISABLE", false),
  };
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envFlag(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadActivity(): ActivityMap {
  try {
    const file = reclaimStateFile();
    if (!existsSync(file)) return {};
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && "spaces" in raw) {
      return normalizeActivity(raw.spaces);
    }
    return {};
  } catch {
    return {};
  }
}

function normalizeActivity(raw: unknown): ActivityMap {
  const out: ActivityMap = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    const ts = Number(v);
    if (Number.isFinite(id) && Number.isFinite(ts)) out[id] = ts;
  }
  return out;
}

export async function saveActivity(map: ActivityMap): Promise<void> {
  let tmp: string | undefined;
  try {
    const file = reclaimStateFile();
    mkdirSync(dirname(file), { recursive: true });
    const payload = JSON.stringify({ spaces: map, v: 1 }, null, 2);
    // Atomic write: write a temp file then rename, so a concurrent harness
    // process never reads a half-written JSON (which would make loadActivity
    // return {} and bypass idle protection).
    tmp = `${file}.tmp.${process.pid}`;
    const write = state.writeFile;
    if (typeof write === "function") {
      await write(tmp, payload, "utf8");
      renameSync(tmp, file);
    }
  } catch {
    // Best-effort: a failing state file must never block agent work. Clean up
    // the temp file so it can't accumulate across runs.
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Record that an agent-owned task space was just selected/used, so the idle
 * reaper keeps it alive. Safe to call for any numeric space id; callers should
 * only call this for agent-owned spaces.
 */
export async function touchTaskSpace(spaceId: number): Promise<void> {
  if (!Number.isFinite(spaceId)) return;
  const map = loadActivity();
  map[spaceId] = typeof state.now === "function" ? state.now() : Date.now();
  await saveActivity(map);
}
