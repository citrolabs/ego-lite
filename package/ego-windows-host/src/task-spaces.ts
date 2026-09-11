import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Ownership = "agent" | "agentDelegatedToUser" | "user";

export type TaskSpace = {
  id: number;
  name: string;
  ownership: Ownership;
  createdBy: string;
  targetIds: string[];
  activeTargetId: string | null;
};

type PersistedState = {
  nextId: number;
  currentId: number | null;
  spaces: TaskSpace[];
};

/**
 * Task spaces emulated as tracked tab sets inside one shared browser profile,
 * the same model PR #134/#202 use on Linux: the profile (and its logins) is
 * shared, ownership and tab membership are host bookkeeping. State persists
 * as JSON so spaces survive across CLI invocations — the browser holds the
 * tabs, this registry holds which tab belongs to which space.
 */
export class TaskSpaceRegistry {
  stateDir: string;
  statePath: string;
  nextId: number;
  currentId: number | null;
  spaces: Map<number, TaskSpace>;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.statePath = join(stateDir, "spaces.json");
    this.nextId = 1;
    this.currentId = null;
    this.spaces = new Map();
    this.load();
  }

  list(): TaskSpace[] {
    return [...this.spaces.values()];
  }

  get(id: number): TaskSpace | undefined {
    return this.spaces.get(id);
  }

  current(): TaskSpace | null {
    if (this.currentId === null) {
      return null;
    }
    return this.spaces.get(this.currentId) ?? null;
  }

  create(name: string): TaskSpace {
    const space: TaskSpace = {
      id: this.nextId++,
      name,
      ownership: "agent",
      createdBy: "agent",
      targetIds: [],
      activeTargetId: null,
    };
    this.spaces.set(space.id, space);
    this.save();
    return space;
  }

  select(id: number): TaskSpace | null {
    const space = this.spaces.get(id);
    if (!space) {
      return null;
    }
    this.currentId = id;
    this.save();
    return space;
  }

  setOwnership(id: number, ownership: Ownership): TaskSpace | null {
    const space = this.spaces.get(id);
    if (!space) {
      return null;
    }
    space.ownership = ownership;
    this.save();
    return space;
  }

  remove(id: number) {
    this.spaces.delete(id);
    if (this.currentId === id) {
      this.currentId = null;
    }
    this.save();
  }

  trackTarget(targetId: string, spaceId = this.currentId) {
    const space = spaceId === null ? null : this.spaces.get(spaceId);
    if (!space || space.targetIds.includes(targetId)) {
      return;
    }
    space.targetIds.push(targetId);
    this.save();
  }

  untrackTarget(targetId: string) {
    let changed = false;
    for (const space of this.spaces.values()) {
      const index = space.targetIds.indexOf(targetId);
      if (index >= 0) {
        space.targetIds.splice(index, 1);
        changed = true;
      }
      if (space.activeTargetId === targetId) {
        space.activeTargetId = space.targetIds.at(-1) ?? null;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  setActive(targetId: string, spaceId = this.currentId) {
    const space = spaceId === null ? null : this.spaces.get(spaceId);
    if (!space || !space.targetIds.includes(targetId)) {
      return;
    }
    space.activeTargetId = targetId;
    this.save();
  }

  /** Drop tracked targets the browser no longer reports (closed tabs). */
  pruneTargets(liveTargetIds: string[]) {
    const live = new Set(liveTargetIds);
    let changed = false;
    for (const space of this.spaces.values()) {
      const kept = space.targetIds.filter((id) => live.has(id));
      if (kept.length !== space.targetIds.length) {
        space.targetIds = kept;
        changed = true;
      }
      if (space.activeTargetId && !live.has(space.activeTargetId)) {
        space.activeTargetId = kept.at(-1) ?? null;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  private load() {
    let raw: string;
    try {
      raw = readFileSync(this.statePath, "utf8");
    } catch {
      return;
    }
    try {
      const state: PersistedState = JSON.parse(raw);
      if (!Number.isFinite(state?.nextId)) {
        return;
      }
      this.nextId = state.nextId;
      this.currentId = state.currentId ?? null;
      for (const space of state.spaces || []) {
        if (Number.isFinite(space?.id) && typeof space?.name === "string") {
          this.spaces.set(space.id, {
            ...space,
            targetIds: Array.isArray(space.targetIds) ? space.targetIds : [],
            activeTargetId: space.activeTargetId ?? null,
          });
        }
      }
    } catch {
      // A corrupt state file starts fresh instead of blocking the host.
    }
  }

  private save() {
    const state: PersistedState = {
      nextId: this.nextId,
      currentId: this.currentId,
      spaces: this.list(),
    };
    mkdirSync(this.stateDir, { recursive: true });
    // Atomic replace so a failed write leaves the previous state valid.
    const tempPath = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state, null, 2));
    renameSync(tempPath, this.statePath);
  }
}
