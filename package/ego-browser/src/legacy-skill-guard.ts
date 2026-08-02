import { markHardStop } from "./output-sink.js";

type InstallTarget = Record<string, unknown>;

/**
 * Globals removed when the agent-facing API moved to Playwright-style facades.
 * Keep this list as the single cleanup source for both embedded and direct-CLI runs.
 */
const LEGACY_GLOBAL_HELPERS = [
  "click",
  "dblclick",
  "hover",
  "drag",
  "wheel",
  "scrollIntoViewIfNeeded",
  "press",
  "insertText",
  "focus",
  "fill",
  "pressSequentially",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "dispatchEvent",
  "textContent",
  "innerText",
  "inputValue",
  "isChecked",
  "getAttribute",
  "count",
  "allInnerTexts",
  "allTextContents",
  "evaluateAll",
  "goto",
  "pageInfo",
  "listTabs",
  "currentTab",
  "switchTab",
  "openOrReuseTab",
  "closeTab",
  "snapshot",
  "snapshotRaw",
  "screenshot",
  "elementCenter",
  "drainEvents",
  "waitForTimeout",
  "waitForLoadState",
  "waitForSelector",
  "waitForFunction",
  "waitForURL",
  "waitForRequest",
  "waitForResponse",
  "setInputFiles",
  "evaluate",
  "serverFetch",
  "browserFetch",
  "listTaskSpaces",
  "switchTaskSpace",
  "newTaskSpace",
  "useOrCreateTaskSpace",
  "claimTaskSpace",
  "completeTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "waitForAgentControl",
  "siteSkills",
  "siteSkillsForUrl",
  "runSiteTool",
  "runSiteBrowserTool",
  "learnContext",
] as const;

/**
 * Task-space helpers can be the first call in a valid old-skill execution round.
 * Install migration tombstones for this narrow set; every other removed global stays
 * absent rather than becoming a second supported API.
 */
export const LEGACY_TASK_SPACE_REPLACEMENTS = {
  listTaskSpaces: "taskSpaces.list()",
  switchTaskSpace: "taskSpaces.switch(nameOrId)",
  newTaskSpace: "taskSpaces.new(name)",
  useOrCreateTaskSpace: "taskSpaces.useOrCreate(nameOrId)",
  claimTaskSpace: "taskSpaces.claim(nameOrId)",
  completeTaskSpace: "taskSpaces.complete(nameOrId, { keep })",
  handOffTaskSpace: "taskSpaces.handOff(nameOrId)",
  takeOverTaskSpace: "taskSpaces.takeOver(nameOrId)",
  waitForAgentControl: "taskSpaces.waitForAgentControl(nameOrId)",
} as const;

export const STALE_SKILL_PREFIX = "[ego-browser:skill-stale]";

type LegacyTaskSpaceHelper = keyof typeof LEGACY_TASK_SPACE_REPLACEMENTS;

export class EgoBrowserSkillStaleError extends Error {
  constructor(legacyHelper: LegacyTaskSpaceHelper, replacement: string) {
    super(
      [
        `${STALE_SKILL_PREFIX} The loaded ego-browser skill uses the removed global helper "${legacyHelper}".`,
        "The ego-browser skill in this conversation no longer matches the installed runtime. Stop this script, re-read the current ego-browser skill, then retry with:",
        `  await ${replacement}`,
        "This is a skill-context mismatch, not an app-update notice.",
      ].join("\n"),
    );
    this.name = "EgoBrowserSkillStaleError";
  }
}

/**
 * Remove every legacy global, then leave non-enumerable migration tombstones only for
 * the old task-space surface. Calling a tombstone hard-stops the current script with a
 * self-contained recovery instruction and marks buffered runs even if agent code catches
 * the Error.
 */
export function installLegacySkillGuards(target: InstallTarget): void {
  for (const name of LEGACY_GLOBAL_HELPERS) {
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      delete target[name];
    }
  }

  for (const [legacyHelper, replacement] of Object.entries(
    LEGACY_TASK_SPACE_REPLACEMENTS,
  ) as [LegacyTaskSpaceHelper, string][]) {
    Object.defineProperty(target, legacyHelper, {
      value: function legacyTaskSpaceSkillGuard(): never {
        const error = new EgoBrowserSkillStaleError(legacyHelper, replacement);
        markHardStop(error.message);
        throw error;
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
