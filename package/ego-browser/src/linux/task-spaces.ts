import type { CdpCall } from "./bridge.js";

export function egoError(
  error_code: string,
  message: string,
): Error & { error_code: string } {
  return Object.assign(new Error(message), { error_code });
}
export function invalid(message: string): never {
  throw Object.assign(new TypeError(message), {
    error_code: "EGO_INVALID_ARGUMENT",
  });
}
export type TaskSpace = {
  id: number;
  taskId: string;
  name: string;
  ownership: "agent" | "user" | "agentDelegatedToUser";
  createdBy: string;
  browserContextId: string;
  profileId: string;
  profileName: string;
};

/** Owned by the host process, so CLI rounds share both contexts and ownership. */
export class LinuxTaskSpaces {
  private nextId = Date.now() * 1000;
  private spaces = new Map<number, TaskSpace>();
  constructor(private cdp: CdpCall) {}

  listProfiles() {
    return {
      profiles: [
        { id: "Default", name: "Isolated Linux sessions", isDefault: true },
      ],
    };
  }
  async listTaskSpaces() {
    return { taskSpaces: [...this.spaces.values()].map((s) => ({ ...s })) };
  }
  require(id: number | null, agent = true): TaskSpace {
    if (id == null)
      throw egoError("EGO_TASK_SPACE_NOT_SELECTED", "Task space not selected");
    const space = this.spaces.get(id);
    if (!space)
      throw egoError("EGO_TASK_SPACE_NOT_FOUND", `Task space not found: ${id}`);
    if (agent && space.ownership !== "agent")
      throw egoError("EGO_TASK_SPACE_USER_IN_CONTROL", "manual_takeover");
    return space;
  }
  async createTaskSpace(name: string, profileId?: string) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      (profileId !== undefined && typeof profileId !== "string")
    )
      invalid("Expected a non-empty name and optional profile id");
    if (profileId && !["default", "Default"].includes(profileId))
      throw egoError(
        "EGO_PROFILE_NOT_FOUND",
        `Profile not found: ${profileId}`,
      );
    const { browserContextId } = await this.cdp("Target.createBrowserContext", {
      disposeOnDetach: false,
    });
    if (!browserContextId)
      throw egoError(
        "EGO_BROWSER_UNAVAILABLE",
        "Browser did not create an isolated context",
      );
    const space: TaskSpace = {
      id: ++this.nextId,
      taskId: name,
      name,
      ownership: "agent",
      createdBy: "agent",
      browserContextId,
      profileId: "Default",
      profileName: "Isolated Linux sessions",
    };
    this.spaces.set(space.id, space);
    return { ...space };
  }
  async closeTaskSpace(id: number) {
    const space = this.require(id);
    await this.cdp("Target.disposeBrowserContext", {
      browserContextId: space.browserContextId,
    });
    this.spaces.delete(id);
    return `${id} task space closed.`;
  }
  async completeTaskSpace(id: number) {
    const space = this.require(id);
    space.ownership = "user";
    return `${id} task space completed.`;
  }
  claimTaskSpace(id: number, name?: string) {
    const space = this.require(id, false);
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim())
        invalid("Expected a non-empty name");
      space.name = space.taskId = name;
    }
    space.ownership = "agent";
    return { ...space };
  }
  handOffTaskSpace(id: number) {
    this.require(id).ownership = "agentDelegatedToUser";
    return `${id} handed off to user.`;
  }
  takeOverTaskSpace(id: number) {
    const space = this.require(id, false);
    if (space.ownership === "user")
      throw egoError(
        "EGO_TASK_SPACE_USER_IN_CONTROL",
        "Completed tasks must be explicitly claimed before reuse",
      );
    space.ownership = "agent";
    return `${id} taken over by agent.`;
  }
}
