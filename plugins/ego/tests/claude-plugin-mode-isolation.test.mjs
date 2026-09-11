import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import test from "node:test";

const repoFile = (path) => new URL(`../../../${path}`, import.meta.url);

const standaloneSkillPath = "skills/ego-browser/SKILL.md";
const claudePluginRoot = "plugins/ego";
const claudeManifestPath = `${claudePluginRoot}/.claude-plugin/plugin.json`;
const claudeSkillPath = `${claudePluginRoot}/skills/ego-browser/SKILL.md`;
const claudeSkillSupportPaths = [
  `${claudePluginRoot}/skills/ego-browser/references/install.md`,
  `${claudePluginRoot}/skills/ego-browser/references/api.md`,
  `${claudePluginRoot}/skills/ego-browser/references/clearing-state.md`,
  `${claudePluginRoot}/skills/ego-browser/scripts/install.sh`,
];
const runtimeTerms =
  /\b(?:REPL|MCP|Bun)\b|\brepl_(?:start|eval|read|status|interrupt|stop)\b/i;

function readRequiredFile(path) {
  const url = repoFile(path);
  assert.equal(existsSync(url), true, `${path} must exist`);
  return readFileSync(url, "utf8");
}

function assertMissing(path) {
  assert.equal(existsSync(repoFile(path)), false, `${path} must not exist`);
}

function assertPureSkillText(value, label) {
  assert.doesNotMatch(value, runtimeTerms, `${label} must use the browser CLI`);
}

function assertTaskSpaceSafety(skill, label) {
  assert.match(
    skill,
    /exactly one TaskSpace for the entire user goal/i,
    `${label} must keep one TaskSpace per user goal`,
  );
  assert.match(
    skill,
    /resume that same space in later rounds/i,
    `${label} must resume the existing TaskSpace across rounds`,
  );
  assert.match(
    skill,
    /Claim a user-owned or inactive space only when the\s+user explicitly asks/i,
    `${label} must not implicitly claim a user-owned TaskSpace`,
  );
  assert.match(
    skill,
    /Stop when the user takes control[\s\S]*Do not\s+retry or route around the stop/i,
    `${label} must stop when the user takes control`,
  );
  assert.match(
    skill,
    /After the user confirms, resume the\s+same space:[\s\S]*takeOverTaskSpace\(7\)/i,
    `${label} must wait for user confirmation before resuming a handoff`,
  );
  assert.match(
    skill,
    /task\.finish\(\{ keep: \[\] \}\)/,
    `${label} must document cleanup`,
  );
  assert.match(
    skill,
    /Call `finish\(\)` exactly once and wait for it\s+to resolve before reporting completion/i,
    `${label} must wait for cleanup before reporting completion`,
  );
  assert.match(
    skill,
    /does not verify the resulting application state/i,
    `${label} must distinguish action receipts from verified outcomes`,
  );
}

test("Claude marketplace routes the plugin to its portable subtree", () => {
  const marketplace = JSON.parse(
    readRequiredFile(".claude-plugin/marketplace.json"),
  );

  assert.equal(marketplace.plugins?.length, 1);
  assert.equal(marketplace.plugins[0].source, `./${claudePluginRoot}`);
});

test("Claude plugin subtree contains its manifest and complete Skill only", () => {
  for (const path of [
    claudeManifestPath,
    claudeSkillPath,
    ...claudeSkillSupportPaths,
  ]) {
    readRequiredFile(path);
  }

  assertMissing(`${claudePluginRoot}/.mcp.json`);
  assertMissing(`${claudePluginRoot}/mcp.json`);
  assertMissing(`${claudePluginRoot}/mcp`);
  assertMissing(`${claudePluginRoot}/commands`);
});

test("Claude plugin versions align without an executable runtime", () => {
  const marketplace = JSON.parse(
    readRequiredFile(".claude-plugin/marketplace.json"),
  );
  const source = readRequiredFile(claudeManifestPath);
  const manifest = JSON.parse(source);
  const skill = readRequiredFile(claudeSkillPath);

  assert.equal(manifest.name, marketplace.plugins[0].name);
  assert.equal(manifest.version, marketplace.plugins[0].version);
  assert.match(skill, new RegExp(`version: ["']${manifest.version}["']`));
  assertPureSkillText(source, "Claude plugin manifest");
});

test("Claude plugin publishes under the ego install and slash namespace", () => {
  const marketplace = JSON.parse(
    readRequiredFile(".claude-plugin/marketplace.json"),
  );
  const manifest = JSON.parse(readRequiredFile(claudeManifestPath));
  const pluginReadme = readRequiredFile(`${claudePluginRoot}/README.md`);

  assert.equal(marketplace.plugins[0].name, "ego");
  assert.equal(manifest.name, "ego");
  assert.match(pluginReadme, /claude --plugin-dir/);
  assert.match(pluginReadme, /ego@ego-agent-skills/);
  assert.match(pluginReadme, /\/ego:ego-browser/);
  assert.doesNotMatch(pluginReadme, /ego-skills|browser-skills/);
});

test("standalone Skill keeps the heredoc execution contract", () => {
  const skill = readRequiredFile(standaloneSkillPath);

  assert.match(skill, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(skill, "standalone Skill");
});

test("portable Skill and support files use the same heredoc contract", () => {
  const standalone = readRequiredFile(standaloneSkillPath);
  const portable = readRequiredFile(claudeSkillPath);
  const support = claudeSkillSupportPaths.map(readRequiredFile).join("\n");

  assert.equal(portable, standalone);
  assert.match(portable, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(`${portable}\n${support}`, "portable Skill package");
});

test("portable Skill restores v2 Pages across script rounds", () => {
  const skill = readRequiredFile(claudeSkillPath);

  assert.match(
    skill,
    /Every invocation starts a new Node\.js process[\s\S]*Page labels\s+persist; JavaScript variables do not/i,
  );
  assert.match(skill, /await taskSpace\(7\);[\s\S]*resumed\.page\("p1"\)/);
  assert.match(skill, /After the page changes, take a new snapshot/);
  assert.doesNotMatch(
    skill,
    /switchTaskSpace|completeTaskSpace|closeTaskSpace/,
  );
});

test("source plugin links directly to the canonical Skill", () => {
  const canonicalRoot = "skills/ego-browser";
  const packagedRoot = `${claudePluginRoot}/skills/ego-browser`;
  assert.equal(lstatSync(repoFile(packagedRoot)).isSymbolicLink(), true);
  assert.equal(
    realpathSync(repoFile(packagedRoot)),
    realpathSync(repoFile(canonicalRoot)),
  );
});

test("both Skill copies preserve TaskSpace safety policy", () => {
  for (const [label, path] of [
    ["standalone Skill", standaloneSkillPath],
    ["portable Skill", claudeSkillPath],
  ]) {
    assertTaskSpaceSafety(readRequiredFile(path), label);
  }
});
