import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LEGACY_GLOBAL_HELPERS,
  LEGACY_TASK_SPACE_REPLACEMENTS,
  STALE_SKILL_PREFIX,
  installLegacySkillGuards,
} from "../dist/src/legacy-skill-guard.js";
import { resetSink } from "../dist/src/output-sink.js";

const SKILL_URL = new URL(
  "../../../skills/ego-browser/SKILL.md",
  import.meta.url,
);

const EXPECTED_TASK_SPACE_REPLACEMENTS = {
  listTaskSpaces: "taskSpaces.list()",
  switchTaskSpace: "taskSpaces.switch(nameOrId)",
  newTaskSpace: "taskSpaces.new(name)",
  useOrCreateTaskSpace: "taskSpaces.useOrCreate(nameOrId)",
  claimTaskSpace: "taskSpaces.claim(nameOrId)",
  completeTaskSpace: "taskSpaces.complete(nameOrId, { keep })",
  handOffTaskSpace: "taskSpaces.handOff(nameOrId)",
  takeOverTaskSpace: "taskSpaces.takeOver(nameOrId)",
  waitForAgentControl: "taskSpaces.waitForAgentControl(nameOrId)",
};

test("legacy skill guards cover only the removed task-space global surface", () => {
  assert.deepEqual(
    LEGACY_TASK_SPACE_REPLACEMENTS,
    EXPECTED_TASK_SPACE_REPLACEMENTS,
  );

  const target = {
    click() {},
    siteSkills() {},
  };
  for (const name of Object.keys(EXPECTED_TASK_SPACE_REPLACEMENTS)) {
    target[name] = () => {};
  }

  installLegacySkillGuards(target);

  assert.equal(target.click, undefined);
  assert.equal(target.siteSkills, undefined);
  for (const [legacyHelper, replacement] of Object.entries(
    EXPECTED_TASK_SPACE_REPLACEMENTS,
  )) {
    assert.equal(typeof target[legacyHelper], "function");
    assert.equal(
      Object.prototype.propertyIsEnumerable.call(target, legacyHelper),
      false,
    );
    resetSink();
    assert.throws(
      () => target[legacyHelper](),
      (error) => {
        assert.equal(error.name, "EgoBrowserSkillStaleError");
        assert.ok(error.message.startsWith(STALE_SKILL_PREFIX));
        assert.ok(error.message.includes(`"${legacyHelper}"`));
        assert.match(
          error.message,
          /skill in this conversation no longer matches the installed runtime/,
        );
        assert.doesNotMatch(error.message, /Playwright/i);
        assert.ok(error.message.includes(`await ${replacement}`));
        return true;
      },
    );
  }
  resetSink();
});

test("the current skill examples do not call removed global helpers", () => {
  const skill = readFileSync(fileURLToPath(SKILL_URL), "utf8");
  const examples = executableCodeBlocks(skill);

  assert.notEqual(examples, "", "SKILL.md must contain executable examples");

  for (const helper of LEGACY_GLOBAL_HELPERS) {
    const unqualifiedCall = new RegExp(
      `(?<![\\w.])${escapeRegExp(helper)}(?=\\s*\\()`,
      "g",
    );
    assert.doesNotMatch(
      examples,
      unqualifiedCall,
      `SKILL.md must use the current facade instead of ${helper}(...)`,
    );
  }
});

function executableCodeBlocks(markdown) {
  return [
    ...markdown.matchAll(
      /```(?:bash|js|javascript|ts|typescript)\n([\s\S]*?)```/g,
    ),
  ]
    .map((match) => match[1])
    .join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
