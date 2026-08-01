import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

type PersistPayload = PersistShape;

function mkTempPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

export type AtomicPersistHooks = {
  /** Deterministic failpoint for crash-safety tests. */
  beforeRename?: (tmpPath: string, targetPath: string) => Promise<void>;
};

export async function writePersistAtomically(
  path: string,
  payload: PersistPayload,
  hooks: AtomicPersistHooks = {},
): Promise<void> {
  const tmpPath = mkTempPath(path);
  const text = JSON.stringify(payload, null, 2);
  const handle = await open(tmpPath, "wx", 0o600);
  let handleOpen = true;
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await hooks.beforeRename?.(tmpPath, path);
    await rename(tmpPath, path);

    // Persist the new directory entry as well as the file contents.
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (err) {
    if (handleOpen) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
    try {
      await unlink(tmpPath);
    } catch {
      // Best-effort cleanup only
    }
    throw err;
  }
}

export type Ownership = "agent" | "agentDelegatedToUser" | "user";

export type Space = {
  taskId: string;
  id: number;
  name: string;
  createdBy: "agent" | "user";
  ownership: Ownership;
  recentTabTitles?: string[];
  targetIds: string[];
};

export type UseResult =
  | { ok: true; space: Space }
  | { ok: false; error_code: string; error: string };

type PersistShape = {
  nextId: number;
  selectedId: number | null;
  spaces: Space[];
};

const USER_SPACE_ID = 1;

function bootstrapUserSpace(): Space {
  return {
    taskId: "user",
    id: USER_SPACE_ID,
    name: "user",
    createdBy: "user",
    ownership: "user",
    targetIds: [],
  };
}

function cloneSpace(space: Space): Space {
  return {
    ...space,
    targetIds: [...space.targetIds],
    ...(space.recentTabTitles
      ? { recentTabTitles: [...space.recentTabTitles] }
      : {}),
  };
}

/**
 * Task Spaces = named tab sets + ownership in one shared Chromium profile.
 * Isolation is tabs/control, not cookies.
 */
export class SpaceManager {
  private readonly persistPath: string | undefined;
  private nextId = USER_SPACE_ID + 1;
  private selectedId: number | null = null;
  private spaces: Space[] = [bootstrapUserSpace()];
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
  }

  async load(): Promise<void> {
    if (!this.persistPath) return;
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as PersistShape;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.spaces)
      ) {
        this.resetBootstrap();
        return;
      }
      const spaces: Space[] = [];
      for (const entry of parsed.spaces) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.id !== "number" || typeof entry.name !== "string") {
          continue;
        }
        const ownership = entry.ownership;
        if (
          ownership !== "agent" &&
          ownership !== "agentDelegatedToUser" &&
          ownership !== "user"
        ) {
          continue;
        }
        const createdBy =
          entry.createdBy === "agent" || entry.createdBy === "user"
            ? entry.createdBy
            : ownership === "user"
              ? "user"
              : "agent";
        spaces.push({
          taskId:
            typeof entry.taskId === "string" ? entry.taskId : String(entry.id),
          id: entry.id,
          name: entry.name,
          createdBy,
          ownership,
          targetIds: Array.isArray(entry.targetIds)
            ? entry.targetIds.filter((t): t is string => typeof t === "string")
            : [],
          ...(Array.isArray(entry.recentTabTitles)
            ? {
                recentTabTitles: entry.recentTabTitles.filter(
                  (t): t is string => typeof t === "string",
                ),
              }
            : {}),
        });
      }
      if (!spaces.some((s) => s.id === USER_SPACE_ID)) {
        spaces.unshift(bootstrapUserSpace());
      }
      this.spaces = spaces;
      this.nextId =
        typeof parsed.nextId === "number" && parsed.nextId > USER_SPACE_ID
          ? parsed.nextId
          : Math.max(USER_SPACE_ID + 1, ...spaces.map((s) => s.id + 1));
      if (
        parsed.selectedId === null ||
        parsed.selectedId === undefined ||
        typeof parsed.selectedId !== "number"
      ) {
        this.selectedId = null;
      } else if (this.findSpace(parsed.selectedId)) {
        this.selectedId = parsed.selectedId;
      } else {
        this.selectedId = null;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.resetBootstrap();
        return;
      }
      // Corrupt JSON or unexpected shape → bootstrap
      this.resetBootstrap();
    }
  }

  async save(): Promise<void> {
    if (!this.persistPath) return;
    const payload: PersistPayload = {
      nextId: this.nextId,
      selectedId: this.selectedId,
      spaces: this.spaces.map(cloneSpace),
    };
    await mkdir(dirname(this.persistPath), { recursive: true });

    const op = this.saveQueue.then(() => writePersistAtomically(this.persistPath!, payload));
    this.saveQueue = op.catch(() => {
      // keep the queue alive; callers keep own failure handling
    });
    await op;
  }

  /** Internal list including targetIds. */
  list(): Space[] {
    return this.spaces.map(cloneSpace);
  }

  /** Public records without targetIds (ego listTaskSpaces shape). */
  listPublic(): Array<Omit<Space, "targetIds"> & { recentTabTitles?: string[] }> {
    return this.spaces.map((s) => {
      const { targetIds: _t, ...rest } = s;
      return {
        ...rest,
        ...(s.recentTabTitles
          ? { recentTabTitles: [...s.recentTabTitles] }
          : {}),
      };
    });
  }

  createAgentSpace(name: string): Space {
    const id = this.nextId++;
    const space: Space = {
      taskId: String(id),
      id,
      name,
      createdBy: "agent",
      ownership: "agent",
      targetIds: [],
    };
    this.spaces.push(space);
    return cloneSpace(space);
  }

  use(id: number): UseResult {
    const space = this.findSpace(id);
    if (!space) {
      return {
        ok: false,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
        error: `task space not found: ${id}`,
      };
    }
    this.selectedId = id;
    return { ok: true, space: cloneSpace(space) };
  }

  claim(id: number, name?: string): Space {
    const space = this.findSpace(id);
    if (!space) {
      throw Object.assign(new Error(`task space not found: ${id}`), {
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      });
    }
    space.ownership = "agent";
    if (name !== undefined && name !== "") {
      space.name = name;
    }
    this.selectedId = id;
    return cloneSpace(space);
  }

  handOff(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.ownership === "agent") {
      space.ownership = "agentDelegatedToUser";
    }
  }

  takeOver(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.ownership === "agentDelegatedToUser") {
      space.ownership = "agent";
    }
  }

  /**
   * Complete selected agent space but keep its tabs: ownership becomes user.
   */
  completeKeep(): void {
    const space = this.selectedSpace();
    if (!space) return;
    if (space.id === USER_SPACE_ID && space.createdBy === "user") {
      // Bootstrap user space stays user-owned; nothing to complete.
      space.ownership = "user";
      return;
    }
    space.ownership = "user";
  }

  /**
   * Close the selected space. Returns targetIds the host should close in Chrome.
   * Protects bootstrap user space id 1 (clears its tabs, does not remove the space).
   */
  closeSelected(): string[] {
    if (this.selectedId === null) return [];
    const space = this.findSpace(this.selectedId);
    if (!space) {
      this.selectedId = null;
      return [];
    }
    const targetIds = [...space.targetIds];
    if (space.id === USER_SPACE_ID) {
      space.targetIds = [];
      space.ownership = "user";
      this.selectedId = null;
      return targetIds;
    }
    this.spaces = this.spaces.filter((s) => s.id !== space.id);
    this.selectedId = null;
    return targetIds;
  }

  selected(): Space | null {
    const space = this.selectedSpace();
    return space ? cloneSpace(space) : null;
  }

  /**
   * Page ops / snapshot blocked when no selection or ownership is user /
   * agentDelegatedToUser (agent control required).
   */
  isPageControlBlocked(): boolean {
    const space = this.selectedSpace();
    if (!space) return true;
    return (
      space.ownership === "user" || space.ownership === "agentDelegatedToUser"
    );
  }

  assignTarget(targetId: string, spaceId?: number): void {
    const destId = spaceId ?? this.selectedId;
    if (destId === null || destId === undefined) {
      throw Object.assign(new Error("task space not selected"), {
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      });
    }
    const dest = this.findSpace(destId);
    if (!dest) {
      throw Object.assign(new Error(`task space not found: ${destId}`), {
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      });
    }
    for (const s of this.spaces) {
      const idx = s.targetIds.indexOf(targetId);
      if (idx !== -1) s.targetIds.splice(idx, 1);
    }
    if (!dest.targetIds.includes(targetId)) {
      dest.targetIds.push(targetId);
    }
  }

  targetsForSelected(): string[] {
    const space = this.selectedSpace();
    return space ? [...space.targetIds] : [];
  }

  spaceIdForTarget(targetId: string): number | null {
    for (const s of this.spaces) {
      if (s.targetIds.includes(targetId)) return s.id;
    }
    return null;
  }

  /** Assign unknown targets to the user space (id 1). Known targets unchanged. */
  adoptOrphanTargets(targetIds: string[]): void {
    const user = this.findSpace(USER_SPACE_ID);
    if (!user) {
      this.spaces.unshift(bootstrapUserSpace());
    }
    const userSpace = this.findSpace(USER_SPACE_ID)!;
    for (const tid of targetIds) {
      if (this.spaceIdForTarget(tid) === null) {
        userSpace.targetIds.push(tid);
      }
    }
  }

  private findSpace(id: number): Space | undefined {
    return this.spaces.find((s) => s.id === id);
  }

  private selectedSpace(): Space | undefined {
    if (this.selectedId === null) return undefined;
    return this.findSpace(this.selectedId);
  }

  private resetBootstrap(): void {
    this.nextId = USER_SPACE_ID + 1;
    this.selectedId = null;
    this.spaces = [bootstrapUserSpace()];
  }
}
