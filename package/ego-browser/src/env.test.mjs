import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentWorkspace } from "../dist/src/env.js";

// Derived the same way env.js derives them, from the built module's own
// location, so the module keeps its internals private.
const SRC_DIR = dirname(
  fileURLToPath(new URL("../dist/src/env.js", import.meta.url)),
);
const REPO_ROOT = resolve(SRC_DIR, "..");
const BUNDLED_SKILL = resolve(SRC_DIR, "ego-browser");
const REPO_SKILL = resolve(REPO_ROOT, "..", "..", "skills", "ego-browser");
const HOME = resolve("/home/agent");
const INSTALL_ROOT = resolve(HOME, ".local", "share", "ego", "ego-skills");

function existsIn(paths) {
  return (path) => paths.includes(path);
}

test("agentWorkspace prefers the EGO_BROWSER_AGENT_WORKSPACE override", () => {
  const override = resolve("/workspaces/custom");
  const result = agentWorkspace({
    env: { EGO_BROWSER_AGENT_WORKSPACE: override },
    exists: () => true,
  });
  assert.equal(result, override);
});

test("agentWorkspace uses the skill bundled next to the build output", () => {
  const result = agentWorkspace({ env: {}, exists: existsIn([BUNDLED_SKILL]) });
  assert.equal(result, BUNDLED_SKILL);
});

test("agentWorkspace uses the repo-layout skill when it exists", () => {
  const result = agentWorkspace({ env: {}, exists: existsIn([REPO_SKILL]) });
  assert.equal(result, REPO_SKILL);
});

test("agentWorkspace falls back to the installed skill registered by onboarding", () => {
  const result = agentWorkspace({
    env: { HOME },
    exists: existsIn([resolve(INSTALL_ROOT, "learnings")]),
  });
  assert.equal(result, INSTALL_ROOT);
});

test("agentWorkspace prefers an ego-browser subdirectory inside the install root", () => {
  const result = agentWorkspace({
    env: { HOME },
    exists: existsIn([
      resolve(INSTALL_ROOT, "ego-browser", "learnings"),
      resolve(INSTALL_ROOT, "learnings"),
    ]),
  });
  assert.equal(result, resolve(INSTALL_ROOT, "ego-browser"));
});

test("agentWorkspace ignores an installed directory without learnings", () => {
  const result = agentWorkspace({
    env: { HOME },
    exists: existsIn([INSTALL_ROOT]),
  });
  assert.equal(result, REPO_SKILL);
});

test("agentWorkspace resolves the home directory from USERPROFILE", () => {
  const result = agentWorkspace({
    env: { USERPROFILE: HOME },
    exists: existsIn([resolve(INSTALL_ROOT, "learnings")]),
  });
  assert.equal(result, INSTALL_ROOT);
});

test("agentWorkspace keeps the repo-layout path when nothing exists", () => {
  const result = agentWorkspace({ env: {}, exists: () => false });
  assert.equal(result, REPO_SKILL);
});
