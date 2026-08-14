import { assertNoEgoError } from "./ego-errors.js";
import { loadActivity, reclaimConfig, saveActivity } from "./taskspace-activity.js";
import { state } from "./state.js";

export type ReclaimSpace = {
  id: number;
  name?: string;
  taskId?: string;
  ownership?: string;
};

export type ReclaimResult = {
  scanned: number;
  reclaimed: number;
  details: string[];
};

type ReclaimDeps = {
  /** Override enumeration (tests). Defaults to ego.listTaskSpaces. */
  list?: () => Promise<ReclaimSpace[]>;
  /** Override closure (tests). Defaults to ego.useTaskSpace + ego.closeTaskSpace. */
  complete?: (id: number) => Promise<unknown>;
  /** Sink for human-readable reclaim notices. */
  log?: (msg: string) => void;
  /** Clock override (ms). */
  now?: () => number;
};

/**
 * Local mirror of helpers.normalizeTaskSpace. Kept here so this module does not
 * import helpers (helpers imports reclaimIdleTaskSpaces); that would be a cycle.
 */
function normalizeTaskSpace(space: unknown): ReclaimSpace | null {
  if (!space || typeof space !== "object") return null;
  const entries = Object.entries(space as object);
  const get = (key: string): unknown =>
    entries.find(([k]) => k === key)?.[1];
  const taskId = get("taskId") ?? get("name") ?? get("id");
  if (taskId === undefined || taskId === null || taskId === "") return null;
  const rawId = get("id") ?? taskId;
  const id = Number(rawId);
  if (!Number.isFinite(id)) return null;
  const rawName = get("name") ?? taskId;
  const rawOwnership = get("ownership");
  return {
    id,
    taskId: String(taskId),
    name: String(rawName),
    ownership: typeof rawOwnership === "string" ? rawOwnership : undefined,
  };
}

async function listAllTaskSpaces(): Promise<ReclaimSpace[]> {
  const ego = globalThis.ego as
    | { listTaskSpaces?: () => Promise<unknown> }
    | undefined;
  if (!ego || typeof ego.listTaskSpaces !== "function") {
    throw new Error("listTaskSpaces requires ego.listTaskSpaces");
  }
  const raw = assertNoEgoError(await ego.listTaskSpaces(), "listTaskSpaces");
  if (!raw || typeof raw !== "object" || !("taskSpaces" in raw)) {
    throw new Error("listTaskSpaces expected { taskSpaces: [...] }");
  }
  const arr = (raw as { taskSpaces: unknown }).taskSpaces;
  if (!Array.isArray(arr)) {
    throw new Error("listTaskSpaces expected { taskSpaces: [...] }");
  }
  return arr
    .map(normalizeTaskSpace)
    .filter((s): s is ReclaimSpace => s !== null);
}

async function closeAgentTaskSpace(id: number): Promise<void> {
  const ego = globalThis.ego as
    | {
        useTaskSpace?: (id: number) => unknown;
        closeTaskSpace?: () => Promise<unknown>;
      }
    | undefined;
  if (!ego) throw new Error("close requires ego runtime");
  if (typeof ego.useTaskSpace === "function") {
    assertNoEgoError(await ego.useTaskSpace(id), "useTaskSpace");
  }
  if (typeof ego.closeTaskSpace !== "function") {
    throw new Error("requires ego.closeTaskSpace");
  }
  assertNoEgoError(await ego.closeTaskSpace(), "closeTaskSpace");
}

/**
 * Close agent-owned task spaces that have been idle past the configured
 * threshold or that exceed the live-space cap, so their renderer processes
 * don't pile up across sessions.
 *
 * Reached once per harness process: app-mode agents hit it via
 * useOrCreateTaskSpace (helpers.ts); CLI mode hits it via run.ts execute().
 * `state.reclaimDone` makes the two entry points collapse to a single reap.
 *
 * Only `ownership === "agent"` spaces are reclaimed. User-owned and
 * agentDelegatedToUser spaces are never touched. Failures are logged but never
 * throw; the agent script still runs.
 */
export async function reclaimIdleTaskSpaces(
  deps: ReclaimDeps = {},
): Promise<ReclaimResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? Date.now;
  const listFn = deps.list ?? listAllTaskSpaces;
  const completeFn = deps.complete ?? closeAgentTaskSpace;

  const cfg = reclaimConfig();
  if (cfg.disabled) return { scanned: 0, reclaimed: 0, details: [] };
  if (state.reclaimDone) return { scanned: 0, reclaimed: 0, details: [] };
  state.reclaimDone = true;

  let spaces: ReclaimSpace[];
  try {
    spaces = await listFn();
  } catch {
    // No ego runtime / cannot enumerate — nothing to reclaim.
    return { scanned: 0, reclaimed: 0, details: [] };
  }

  const agentSpaces = spaces.filter((s) => s && s.ownership === "agent");
  if (agentSpaces.length === 0) {
    return { scanned: 0, reclaimed: 0, details: [] };
  }

  const activity = loadActivity();
  const idleMs = cfg.idleSec * 1000;
  const idleMin = Math.round(idleMs / 60000);

  // First-sight seeding: a space with no activity record (state file missing,
  // fresh machine, or created before this feature shipped — including a space
  // a concurrent omp session is actively using) must never be reclaimed on
  // sight. Seed it with now so it only becomes reclaimable once the idle
  // threshold elapses without further use; the seeded timestamp persists via
  // the prune below.
  const seededIds = new Set<number>();
  for (const s of agentSpaces) {
    if (activity[s.id] === undefined) {
      activity[s.id] = now();
      seededIds.add(s.id);
    }
  }

  // Oldest first (smallest lastTouchedAt). Every agent space now has a record.
  const ranked = agentSpaces
    .map((s) => ({ space: s, lastTs: activity[s.id] ?? 0 }))
    .sort((a, b) => a.lastTs - b.lastTs);

  const reclaimIds = new Set<number>();
  const targets: { space: ReclaimSpace; reason: string }[] = [];

  for (const { space, lastTs } of ranked) {
    if (seededIds.has(space.id)) continue; // just seeded — give it the idle window
    if (now() - lastTs >= idleMs) {
      const mins = Math.round((now() - lastTs) / 60000);
      targets.push({ space, reason: `idle ${mins}min >= ${idleMin}min` });
      reclaimIds.add(space.id);
    }
  }

  // Hard cap: reclaim oldest non-seeded, non-idle spaces when over the cap.
  // Seeded spaces are skipped so a fresh deploy never mass-closes spaces that
  // predate the activity log.
  let over = agentSpaces.length - cfg.maxSpaces;
  if (over > 0) {
    for (const { space } of ranked) {
      if (over <= 0) break;
      if (reclaimIds.has(space.id)) continue;
      if (seededIds.has(space.id)) continue;
      targets.push({
        space,
        reason: `over cap ${agentSpaces.length}/${cfg.maxSpaces}`,
      });
      reclaimIds.add(space.id);
      over--;
    }
  }

  const details: string[] = [];
  let reclaimed = 0;
  for (const { space, reason } of targets) {
    try {
      await completeFn(space.id);
      reclaimed++;
      const label = space.name ?? space.taskId ?? String(space.id);
      details.push(`reclaimed #${space.id} "${label}" — ${reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const label = space.name ?? space.taskId ?? String(space.id);
      details.push(`skip #${space.id} "${label}" — ${reason} — ${msg}`);
    }
  }

  // Prune state entries for spaces that no longer exist.
  const aliveIds = new Set(spaces.map((s) => s.id));
  const next: Record<number, number> = {};
  for (const [id, ts] of Object.entries(activity)) {
    if (aliveIds.has(Number(id))) next[Number(id)] = ts;
  }
  await saveActivity(next);

  if (reclaimed > 0) {
    log(`[ego-reclaim] reclaimed ${reclaimed} idle task space(s):`);
    for (const d of details) log(`  ${d}`);
  }

  return { scanned: agentSpaces.length, reclaimed, details };
}
