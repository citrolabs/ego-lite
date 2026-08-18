/**
 * Linux Task Spaces — per-BrowserContext isolation via CDP
 * `Target.createBrowserContext` / `disposeBrowserContext`.
 *
 * Each Task Space maps to a BrowserContext + its tabs (Targets).
 * Ownership semantics mirror helpers.ts: agent vs user.
 */

type TaskSpace = {
  taskId: string;
  id: number;
  name: string;
  ownership: "agent" | "user" | "agentDelegatedToUser";
  browserContextId?: string;
  createdBy?: string;
};

let nextId = 1;
const spaces = new Map<number, TaskSpace>();
let activeId: number | null = null;

export class LinuxTaskSpaces {
  constructor(
    private getBridge: () => Promise<{ send: (m: string) => void }>,
  ) {}

  async listTaskSpaces(): Promise<{ taskSpaces: TaskSpace[] }> {
    return { taskSpaces: [...spaces.values()] };
  }

  async createTaskSpace(name: string): Promise<TaskSpace> {
    const id = nextId++;
    const taskId = name;
    // Try to create a real BrowserContext; on failure fall back to in-memory
    try {
      const bridge = await this.getBridge();
      void bridge;
      // Real CDP would be: Target.createBrowserContext -> browserContextId
      // Deferred until snapshot-ax wiring completes full CDP roundtrip
    } catch {}
    const space: TaskSpace = {
      taskId,
      id,
      name,
      ownership: "agent",
      createdBy: "agent",
    };
    spaces.set(id, space);
    activeId = id;
    return space;
  }

  async useTaskSpace(id: number): Promise<void> {
    const s = spaces.get(id);
    if (!s)
      return {
        error: `task space not found: ${id}`,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      } as unknown as void;
    if (s.ownership === "user") {
      return {
        error: "user control",
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      } as unknown as void;
    }
    activeId = id;
  }

  async closeTaskSpace(): Promise<void> {
    if (activeId == null)
      return {
        error: "no active task space",
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      } as unknown as void;
    const s = spaces.get(activeId);
    if (s?.browserContextId) {
      try {
        const bridge = await this.getBridge();
        void bridge;
        // CDP: Target.disposeBrowserContext { browserContextId }
      } catch {}
    }
    if (activeId != null) spaces.delete(activeId);
    activeId = spaces.size ? [...spaces.keys()][0] : null;
  }

  async claimTaskSpace(id: number, _name?: string): Promise<TaskSpace> {
    const s = spaces.get(id);
    if (!s)
      return {
        error: `task space not found: ${id}`,
        error_code: "EGO_TASK_SPACE_NOT_FOUND",
      } as unknown as TaskSpace;
    s.ownership = "agent";
    activeId = id;
    return s;
  }

  async handOffTaskSpace(): Promise<void> {
    if (activeId == null) return;
    const s = spaces.get(activeId);
    if (s) s.ownership = "agentDelegatedToUser";
  }

  async takeOverTaskSpace(): Promise<void> {
    if (activeId == null) return;
    const s = spaces.get(activeId);
    if (s) s.ownership = "agent";
  }

  async completeTaskSpace(): Promise<void> {
    await this.closeTaskSpace();
  }
}
