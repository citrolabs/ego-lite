import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repoFile = (path) => new URL(`../../../${path}`, import.meta.url);

const standaloneSkillPath = "skills/ego-browser/SKILL.md";
const guidePath = "package/ego-browser/skill-body/SKILL.md";
const claudePluginRoot = "plugins/ego";
const claudeManifestPath = `${claudePluginRoot}/.claude-plugin/plugin.json`;
const claudeSkillPath = `${claudePluginRoot}/skills/ego-browser/SKILL.md`;
const claudeSkillSupportPaths = [
  `${claudePluginRoot}/skills/ego-browser/references/install.md`,
  `${claudePluginRoot}/skills/ego-browser/references/install-macos.md`,
  `${claudePluginRoot}/skills/ego-browser/references/install-windows.md`,
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

test("standalone Skill defers usage to the versioned guide", () => {
  const skill = readRequiredFile(standaloneSkillPath);

  assert.match(skill, /^ego-browser skill$/m);
  assertPureSkillText(skill, "standalone Skill");
});

test("versioned guide keeps the heredoc execution contract", () => {
  const guide = readRequiredFile(guidePath);

  assert.match(guide, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(guide, "versioned guide");
});

test("portable Skill and support files use the same heredoc contract", () => {
  const standalone = readRequiredFile(standaloneSkillPath);
  const portable = readRequiredFile(claudeSkillPath);
  const support = claudeSkillSupportPaths.map(readRequiredFile).join("\n");

  assert.equal(portable, standalone);
  assert.match(portable, /^ego-browser skill$/m);
  assert.match(support, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(`${portable}\n${support}`, "portable Skill package");
});

test("versioned guide restores v2 Pages across script rounds", () => {
  const skill = readRequiredFile(guidePath);

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

test("source plugin carries an exact copy of the canonical Skill", () => {
  const canonicalRoot = "skills/ego-browser";
  const copyRoot = `${claudePluginRoot}/skills/ego-browser`;
  // Hosts that install the plugin straight from Git drop links that leave
  // the plugin root, so the copy must be real files. Compare the Git index,
  // which is what a commit ships, so untracked drafts do not count.
  const entries = (root) =>
    execFileSync("git", ["ls-files", "--stage", "--", root], {
      cwd: repoFile(""),
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, blob] = meta.split(" ");
        return `${mode} ${blob} ${path.slice(root.length + 1)}`;
      });
  assert.deepEqual(
    entries(copyRoot),
    entries(canonicalRoot),
    `${copyRoot} differs from the canonical Skill: run \`npm --prefix plugins/ego run sync-skills\``,
  );
});

test("versioned guide preserves TaskSpace safety policy", () => {
  assertTaskSpaceSafety(readRequiredFile(guidePath), "versioned guide");
});
