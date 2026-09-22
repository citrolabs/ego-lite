import { markHardStop } from "./output-sink.js";

export const STALE_SKILL_PREFIX = "[ego-browser:skill-stale]";

// These are the public top-level members exposed by the formal 1.3 Skill. Keep
// the guard narrow: 1.2.3 globals remain supported, while unpublished beta
// namespaces do not become a new compatibility surface.
const EGO_BROWSER_13_MEMBERS = new Set([
  "helper",
  "site",
  "showTaskState",
  "snapshot",
  "listProfile",
  "listTaskSpace",
  "newTaskSpace",
  "switchTaskSpace",
  "claimTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "waitForAgentControlTaskSpace",
  "completeTaskSpace",
  "closeTaskSpace",
]);

export class EgoBrowserSkillStaleError extends Error {
  constructor(member: string) {
    super(
      [
        `${STALE_SKILL_PREFIX} This script uses the old egoBrowser.${member} API.`,
        "Run `ego-browser skill` to read the guide for this version and retry with the current TaskSpace/Page API. Start with:",
        "  const task = await taskSpace(nameOrId)",
      ].join("\n"),
    );
    this.name = "EgoBrowserSkillStaleError";
  }
}

/** Create the migration-only namespace installed in place of the 1.3 facade. */
export function createStaleEgoBrowserGuard(): Record<string, unknown> {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (
        typeof property !== "string" ||
        !EGO_BROWSER_13_MEMBERS.has(property)
      ) {
        return undefined;
      }
      const error = new EgoBrowserSkillStaleError(property);
      // A stale Skill is a round-level mismatch. Mark it even if the script
      // catches the Error so unrelated business output cannot hide the remedy.
      markHardStop(error.message);
      throw error;
    },
  });
}

/** Install the guard for SDK hosts that expose helpers directly on globalThis. */
export function installStaleEgoBrowserGuard(
  target: Record<string, unknown>,
): void {
  Object.defineProperty(target, "egoBrowser", {
    value: createStaleEgoBrowserGuard(),
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
