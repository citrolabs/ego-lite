import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repoFile = (path) => new URL(`../../../${path}`, import.meta.url);
const pluginRoot = "plugins/ego";
const runtimeTerms =
  /\b(?:MCP|REPL|Bun)\b|\brepl_(?:start|eval|read|status|interrupt|stop)\b/i;
const skillVersion = read("skills/ego-browser/SKILL.md").match(
  /^\s+version: "([^"]+)"/m,
)[1];

function read(path) {
  const url = repoFile(path);
  assert.equal(existsSync(url), true, `${path} must exist`);
  return readFileSync(url, "utf8");
}

function json(path) {
  return JSON.parse(read(path));
}

function assertMissing(path) {
  assert.equal(existsSync(repoFile(path)), false, `${path} must not exist`);
}

function assertPureSkillText(value, label) {
  assert.doesNotMatch(
    value,
    runtimeTerms,
    `${label} must not require a runtime`,
  );
}

test("one pure-Skill portable root serves Agent Plugins hosts", () => {
  const source = read(`${pluginRoot}/plugin.json`);
  const manifest = JSON.parse(source);

  assert.equal(
    manifest.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  );
  assert.equal(manifest.name, "ego");
  assert.equal(manifest.version, skillVersion);
  assertPureSkillText(source, "Agent Plugins manifest");
  read(`${pluginRoot}/skills/ego-browser/SKILL.md`);
  assertMissing(`${pluginRoot}/mcp.json`);
});

test("branded hosts expose explicit pure-Skill manifests", () => {
  const shared = json(`${pluginRoot}/plugin.json`);
  const pkg = json(`${pluginRoot}/package.json`);

  for (const [host, path, skills] of [
    ["Cursor", ".cursor-plugin/plugin.json", "./skills/"],
    ["CodeBuddy", ".codebuddy-plugin/plugin.json", ["./skills/ego-browser"]],
    ["WorkBuddy", ".workbuddy-plugin/plugin.json", ["./skills/ego-browser"]],
    ["QoderWork", ".qoder-plugin/plugin.json", ["./skills/ego-browser"]],
  ]) {
    const source = read(`${pluginRoot}/${path}`);
    const manifest = JSON.parse(source);

    assert.equal(manifest.name, shared.name, `${host} name must stay aligned`);
    assert.equal(
      manifest.version,
      shared.version,
      `${host} version must stay aligned`,
    );
    assert.equal(
      manifest.description,
      shared.description,
      `${host} description must stay aligned`,
    );
    assert.deepEqual(
      manifest.author,
      shared.author,
      `${host} author must stay aligned`,
    );
    assert.deepEqual(manifest.skills, skills, `${host} must declare its Skill`);
    assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
    assert.equal(Object.hasOwn(manifest, "commands"), false);
    assertPureSkillText(source, `${host} manifest`);
  }

  assert.deepEqual(
    json(`${pluginRoot}/.codebuddy-plugin/plugin.json`),
    json(`${pluginRoot}/.workbuddy-plugin/plugin.json`),
    "WorkBuddy's authoritative and branded manifests must not drift",
  );

  for (const path of [
    "plugin.json",
    ".claude-plugin",
    ".codex-plugin",
    ".cursor-plugin",
    ".codebuddy-plugin",
    ".workbuddy-plugin",
    ".qoder-plugin",
  ]) {
    assert.ok(pkg.files.includes(path), `${path} must ship in the npm package`);
  }
});

test("Claude compatibility files expose only the portable Skill", () => {
  const marketplace = json(".claude-plugin/marketplace.json");
  const source = read(`${pluginRoot}/.claude-plugin/plugin.json`);
  const manifest = JSON.parse(source);

  assert.equal(marketplace.plugins[0].name, "ego");
  assert.equal(marketplace.plugins[0].source, `./${pluginRoot}`);
  assert.equal(manifest.name, "ego");
  assert.equal(manifest.version, skillVersion);
  assert.equal(marketplace.metadata.version, manifest.version);
  assertPureSkillText(source, "Claude manifest");
  assertMissing(`${pluginRoot}/.mcp.json`);
});

test("Codex marketplace and manifest expose the same pure-Skill plugin", () => {
  const marketplace = json(".agents/plugins/marketplace.json");
  const source = read(`${pluginRoot}/.codex-plugin/plugin.json`);
  const manifest = JSON.parse(source);
  const entry = marketplace.plugins.find((item) => item.name === "ego");

  assert.equal(marketplace.name, "ego-agent-skills");
  assert.deepEqual(entry.source, {
    source: "local",
    path: "./plugins/ego",
  });
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
  assert.equal(manifest.name, "ego");
  assert.equal(manifest.version, skillVersion);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
  assertPureSkillText(source, "Codex manifest");
});

test("OpenCode adapter injects only instructions and the Skill slash command", async () => {
  const pkgSource = read(`${pluginRoot}/package.json`);
  const pkg = JSON.parse(pkgSource);
  assert.equal(pkg.name, "@citrolabs/ego");
  assert.equal(pkg.version, skillVersion);
  assert.equal(pkg.exports["."], "./index.js");
  assert.equal(pkg.exports["./server"], "./index.js");
  assert.equal(pkg.exports["./dsh"], "./dsh/src/index.js");
  assert.ok(pkg.files.includes("skills"));
  assert.ok(pkg.files.every((path) => !/^mcp(?:\/|$)/i.test(path)));
  assertPureSkillText(pkgSource, "npm package metadata");

  const adapterSource = read(`${pluginRoot}/index.js`);
  const { EgoBrowserPlugin } = await import(
    new URL(`../../../${pluginRoot}/index.js`, import.meta.url)
  );
  const hooks = await EgoBrowserPlugin({});
  const config = {};
  await hooks.config(config);

  assert.equal(config.mcp, undefined);
  assert.equal(config.instructions.length, 1);
  assert.match(
    config.instructions[0],
    /plugins\/ego\/skills\/ego-browser\/SKILL\.md$/,
  );
  assert.match(config.command["ego-browser"].template, /\$ARGUMENTS/);
  assertPureSkillText(adapterSource, "OpenCode adapter");
  assertPureSkillText(
    config.command["ego-browser"].template,
    "OpenCode slash command",
  );
});

test("portable Skill is the standalone heredoc Skill without runtime tools", () => {
  const standalone = read("skills/ego-browser/SKILL.md");
  const portable = read(`${pluginRoot}/skills/ego-browser/SKILL.md`);

  assert.equal(portable, standalone);
  assert.match(portable, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(portable, "portable Skill");
});

test("DeepSeek Harness adapter registers only the packaged Skill", () => {
  const pkg = json(`${pluginRoot}/package.json`);
  const patch = read(`${pluginRoot}/cordis.patch.yml`);
  const adapter = read(`${pluginRoot}/dsh/src/index.js`);

  assert.deepEqual(pkg.dsh, {
    bundle: { patch: "./cordis.patch.yml" },
  });
  assert.ok(pkg.files.includes("cordis.patch.yml"));
  assert.ok(pkg.files.includes("dsh"));
  assert.ok(pkg.files.every((path) => !/^mcp(?:\/|$)/i.test(path)));
  assert.match(patch, /name:\s*['"]?@citrolabs\/ego\/dsh['"]?/);
  assert.match(adapter, /ctx\.skills\.registerProvider/);
  assert.doesNotMatch(
    adapter,
    /ctx\.tools\.register|\bsubprocess\b|ReplSession|createAgentSessionPool|spawnDshTerminal|repl_/i,
  );
  assertMissing(`${pluginRoot}/dsh/src/agent-session-pool.js`);
  assertMissing(`${pluginRoot}/dsh/src/terminal-adapter.js`);
});

test("portable plugin contains no MCP or persistent-REPL runtime artifacts", () => {
  for (const path of [
    `${pluginRoot}/mcp.json`,
    `${pluginRoot}/.mcp.json`,
    `${pluginRoot}/mcp`,
    `${pluginRoot}/dsh/src/agent-session-pool.js`,
    `${pluginRoot}/dsh/src/terminal-adapter.js`,
  ]) {
    assertMissing(path);
  }
});

test("portable plugin ships the repository license", () => {
  assert.equal(read(`${pluginRoot}/LICENSE`), read("LICENSE"));
});

test("portable Skill includes Codex UI metadata", () => {
  const metadata = read(`${pluginRoot}/skills/ego-browser/agents/openai.yaml`);

  assert.match(metadata, /display_name: ["']ego-browser["']/);
  assert.match(metadata, /short_description:/);
  assert.match(metadata, /default_prompt: ["'][^"']*\$ego-browser/);
});

test("standalone Skill remains the heredoc source of truth", () => {
  const skill = read("skills/ego-browser/SKILL.md");
  assert.match(skill, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(skill, "standalone Skill");
});

test("plugin README documents every host as a pure-Skill install", () => {
  const readme = read(`${pluginRoot}/README.md`);

  for (const host of [
    "Claude Code",
    "Codex",
    "Cursor",
    "GitHub Copilot",
    "Grok Build",
    "WorkBuddy",
    "QwenWork Desktop",
    "OpenCode",
    "DeepSeek Harness",
  ]) {
    assert.match(readme, new RegExp(`### ${host}\\b`));
  }

  assert.match(readme, /claude --plugin-dir/);
  assert.match(readme, /codex plugin add ego@ego-codex-local/);
  assert.match(readme, /cursor-agent[\s\\]*--plugin-dir/);
  assert.match(readme, /\.cursor-plugin\/plugin\.json/);
  assert.match(readme, /copilot --plugin-dir/);
  assert.match(readme, /grok plugin install \/absolute\/path/);
  assert.match(readme, /\.codebuddy-plugin\/plugin\.json/);
  assert.match(readme, /\.workbuddy-plugin\/plugin\.json/);
  assert.match(readme, /\.qoder-plugin\/plugin\.json/);
  assert.match(readme, /opencode plugin "file:/);
  assert.match(readme, /dsh plugin --profile web add \/absolute\/path/);
  assert.match(
    readme,
    new RegExp(
      `dist/plugins/ego-v${json(`${pluginRoot}/plugin.json`).version}/`,
    ),
  );
  assert.match(readme, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(readme, "plugin README");
});
