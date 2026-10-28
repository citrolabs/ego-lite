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

  for (const path of [
    "plugin.json",
    ".claude-plugin",
    ".codex-plugin",
    ".cursor-plugin",
    ".codebuddy-plugin",
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

test("Cursor marketplace routes the repository to the plugin", () => {
  const marketplace = json(".cursor-plugin/marketplace.json");
  const plugin = json(`${pluginRoot}/.cursor-plugin/plugin.json`);

  assert.equal(marketplace.name, "ego-agent-skills");
  assert.equal(marketplace.owner.name, plugin.author.name);
  assert.deepEqual(marketplace.plugins, [
    {
      name: plugin.name,
      source: `./${pluginRoot}`,
      description: plugin.description,
    },
  ]);
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
  // Codex reads keywords only from the Agent Plugins root manifest; the
  // .codex-plugin overlay contributes apps, hooks, and interface alone.
  const portable = json(`${pluginRoot}/plugin.json`);
  assert.ok(
    portable.keywords?.length,
    "root plugin.json must declare keywords, or plugin search cannot match them",
  );
  assert.deepEqual(
    portable.keywords,
    manifest.keywords,
    "root and Codex keywords must not drift",
  );
  assertPureSkillText(source, "Codex manifest");
});

// Values the plugin submission portal accepts, from
// https://developers.openai.com/plugins/deploy/submission-errors
const CODEX_CATEGORIES = [
  "Productivity",
  "Creativity",
  "Developer Tools",
  "Business & Operations",
  "Data & Analytics",
  "Communication",
  "Education & Research",
  "Security",
  "Finance",
  "Healthcare",
  "Travel",
  "Entertainment",
  "Other",
];

test("Codex listing metadata satisfies the plugin directory", () => {
  const manifest = json(`${pluginRoot}/.codex-plugin/plugin.json`);
  const listing = manifest.interface;

  assert.ok(
    CODEX_CATEGORIES.includes(listing.category),
    `interface.category ${JSON.stringify(listing.category)} is rejected as plugin_category_unknown; use one of ${CODEX_CATEGORIES.join(", ")}`,
  );
  // Final directory submission caps each field below the package-validation limit.
  for (const [field, limit] of [
    ["displayName", 30],
    ["shortDescription", 30],
    ["longDescription", 4000],
    ["developerName", 80],
  ]) {
    const value = listing[field];
    assert.ok(
      value?.trim(),
      `interface.${field} is required by the plugin directory`,
    );
    assert.ok(
      value.length <= limit,
      `interface.${field} must be ${limit} characters or fewer for final directory submission, but is ${value.length}`,
    );
  }
  assert.equal(
    listing.developerName,
    manifest.author.name,
    "author.name and interface.developerName must match, or the portal asks to confirm a default",
  );
  // The portal blocks a skills-only upload without these, although the
  // published docs only require them for MCP review.
  for (const field of [
    "websiteURL",
    "supportURL",
    "privacyPolicyURL",
    "termsOfServiceURL",
  ]) {
    const value = listing[field];
    assert.ok(value, `interface.${field} is required by the plugin directory`);
    const url = new URL(value);
    assert.equal(url.protocol, "https:", `interface.${field} must use HTTPS`);
    assert.equal(
      url.username + url.password,
      "",
      `interface.${field} must not embed credentials`,
    );
    assert.ok(
      value.length <= 1024,
      `interface.${field} must be 1024 characters or fewer, but is ${value.length}`,
    );
  }
  // OpenAI ignores the whole .codex-plugin overlay once the root manifest
  // declares extensions.com.openai; the two are not merged.
  assert.equal(
    json(`${pluginRoot}/plugin.json`).extensions?.["com.openai"],
    undefined,
    "root plugin.json must not declare extensions.com.openai, or the portal drops this listing",
  );
  for (const field of ["composerIcon", "logo"]) {
    const asset = listing[field];
    assert.match(
      asset,
      /^\.\//,
      `interface.${field} must be a plugin-relative path starting with ./`,
    );
    assert.equal(
      existsSync(repoFile(`${pluginRoot}/${asset}`)),
      true,
      `interface.${field} points to a missing file: ${asset}`,
    );
  }
});

test("OpenCode adapter registers only the packaged Skill", async () => {
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
  const { default: plugin } = await import(
    new URL(`../../../${pluginRoot}/index.js`, import.meta.url)
  );
  // OpenCode 1 reads id and server(), and rejects a default export that also
  // has tui(). OpenCode 2 reads id and setup().
  assert.equal(typeof plugin.id, "string");
  assert.equal(typeof plugin.server, "function");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin.tui, undefined);

  const hooks = await plugin.server({});
  const config = {};
  await hooks.config(config);
  await hooks.config(config);

  assert.equal(config.mcp, undefined);
  assert.equal(config.instructions, undefined);
  assert.equal(
    config.command,
    undefined,
    "OpenCode derives /ego-browser from the Skill",
  );
  // OpenCode reads only skills.paths from the normalized config, even when
  // the user's file lists Skill folders as a plain array.
  assert.equal(
    config.skills.paths.length,
    1,
    "repeated hooks add the path once",
  );
  assert.match(config.skills.paths[0], /plugins\/ego\/skills$/);

  const user = { skills: { paths: ["/user/skills"], urls: [] } };
  await hooks.config(user);
  assert.deepEqual(user.skills, {
    paths: ["/user/skills", config.skills.paths[0]],
    urls: [],
  });

  const skills = new Map();
  const ctx = {
    skill: {
      transform: async (edit) =>
        edit({
          get: (id) => skills.get(id),
          add: (skill) => skills.set(skill.id, skill),
        }),
    },
  };
  await plugin.setup(ctx);
  const skill = skills.get("ego-browser");
  const skillText = read(`${pluginRoot}/skills/ego-browser/SKILL.md`);
  assert.deepEqual(Object.keys(skill), [
    "id",
    "name",
    "description",
    "path",
    "content",
  ]);
  assert.equal(skill.name, "ego-browser");
  assert.match(skill.path, /plugins\/ego\/skills\/ego-browser\/SKILL\.md$/);
  // OpenCode 2 stores the Skill body without its front matter.
  assert.equal(
    skill.content,
    skillText.slice(skillText.indexOf("\n---\n") + "\n---\n".length),
  );
  assert.ok(skillText.includes(`\ndescription: ${skill.description}\n`));
  assert.doesNotMatch(
    skill.description,
    /^[>|"']/,
    "the adapter reads a plain one-line description",
  );

  skills.set("ego-browser", { id: "ego-browser", path: "/user/SKILL.md" });
  await plugin.setup(ctx);
  assert.equal(
    skills.get("ego-browser").path,
    "/user/SKILL.md",
    "a Skill the user already has keeps priority",
  );
  assertPureSkillText(adapterSource, "OpenCode adapter");
});

test("every host that shows a plugin logo uses the Skill logo", () => {
  const logo = "skills/ego-browser/assets/logo.png";
  for (const [label, value] of [
    [
      "Codex interface.logo",
      json(`${pluginRoot}/.codex-plugin/plugin.json`).interface.logo,
    ],
    ["Claude icon", json(`${pluginRoot}/.claude-plugin/plugin.json`).icon],
    ["Cursor logo", json(`${pluginRoot}/.cursor-plugin/plugin.json`).logo],
  ]) {
    assert.equal(value.replace(/^\.\//, ""), logo, `${label} must be ${logo}`);
  }
  assert.equal(existsSync(repoFile(`${pluginRoot}/${logo}`)), true);
});

test("portable Skill is the standalone entry Skill without runtime tools", () => {
  const standalone = read("skills/ego-browser/SKILL.md");
  const portable = read(`${pluginRoot}/skills/ego-browser/SKILL.md`);

  assert.equal(portable, standalone);
  assert.match(portable, /^ego-browser skill$/m);
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

test("versioned guide remains the heredoc source of truth", () => {
  const guide = read("package/ego-browser/skill-body/SKILL.md");
  assert.match(guide, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(guide, "versioned guide");
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
    "Pi",
  ]) {
    assert.match(readme, new RegExp(`### ${host}\\b`));
  }

  assert.match(readme, /claude --plugin-dir/);
  assert.match(readme, /codex plugin add ego@ego-codex-local/);
  assert.match(readme, /agent --plugin-dir/);
  assert.match(readme, /\.cursor-plugin\/plugin\.json/);
  assert.match(readme, /copilot --plugin-dir/);
  assert.match(readme, /grok plugin install \/absolute\/path\S* --trust/);
  assert.match(readme, /\.codebuddy-plugin\/plugin\.json/);
  assert.match(readme, /\.qoder-plugin\/plugin\.json/);
  assert.match(readme, /opencode plugin \/absolute\/path/);
  assert.match(readme, /opencode plugin add @ego-lite\/opencode-plugin/);
  assert.match(readme, /dsh plugin --profile web add \/absolute\/path/);
  assert.match(readme, /pi install npm:@ego-lite\/pi-plugin/);
  assert.match(
    readme,
    new RegExp(
      `dist/plugins/ego-v${json(`${pluginRoot}/plugin.json`).version}/`,
    ),
  );
  assert.match(readme, /ego-browser nodejs <<'EOF'/);
  assertPureSkillText(readme, "plugin README");
});
