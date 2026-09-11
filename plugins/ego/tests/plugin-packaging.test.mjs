import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const targets = [
  ["claude-code", "Claude Code", [".claude-plugin"]],
  ["codex", "Codex", [".codex-plugin"], ".agents/plugins/marketplace.json"],
  ["cursor", "Cursor", [".cursor-plugin"]],
  ["github-copilot", "GitHub Copilot", [".claude-plugin"]],
  ["grok-build", "Grok Build", []],
  [
    "workbuddy",
    "WorkBuddy",
    [".claude-plugin", ".codebuddy-plugin", ".workbuddy-plugin"],
    ".claude-plugin/marketplace.json",
  ],
  ["qwenwork", "QwenWork Desktop", [".claude-plugin"]],
  ["opencode", "OpenCode"],
  ["deepseek-harness", "DeepSeek Harness"],
];

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function addPlugin(root, name, version, skillName) {
  const pluginRoot = join(root, "plugins", name);
  const manifest = {
    name,
    version,
    description: `${name} fixture`,
    author: { name: "example" },
  };
  writeJson(join(pluginRoot, "plugin.json"), manifest);
  for (const directory of new Set(
    targets.flatMap((target) => target[2] ?? []),
  )) {
    writeJson(join(pluginRoot, directory, "plugin.json"), manifest);
  }
  mkdirSync(join(pluginRoot, "skills"), { recursive: true });
  symlinkSync(
    relative(join(pluginRoot, "skills"), join(root, "skills", skillName)),
    join(pluginRoot, "skills", skillName),
  );
  write(
    join(pluginRoot, "README.md"),
    `# ${name}\n\n## Requirements\n\nFixture requirements.\n\n## Installation\n\n${targets.map(([, title]) => `### ${title}\n\nInstall in ${title}.\n`).join("\n")}\n## Development\n\nDo not ship these instructions.\n`,
  );
  write(join(pluginRoot, "LICENSE"), "fixture license\n");
  writeJson(join(pluginRoot, "package.json"), {
    name: `@example/${name}`,
    version,
    type: "module",
    scripts: { prepare: "must-not-run" },
    exports: {
      ".": "./index.js",
      "./server": "./index.js",
      "./dsh": "./dsh/src/index.js",
    },
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  });
  write(join(pluginRoot, "index.js"), "export default async () => ({});\n");
  write(
    join(pluginRoot, "cordis.patch.yml"),
    `- insert:\n    - id: ${name}\n      name: '@example/${name}/dsh'\n`,
  );
  write(
    join(pluginRoot, "dsh", "src", "index.js"),
    "export const name = 'fixture';\n",
  );
  write(
    join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: canonical ${skillName}\n---\n\n# ${skillName}\n`,
  );
  write(
    join(root, "skills", skillName, "references", "install.md"),
    `canonical ${skillName} reference\n`,
  );
  for (const path of [
    "mcp/server.js",
    "node_modules/fixture/index.js",
    ".DS_Store",
    "dist/old.zip",
    "tests/plugin.test.mjs",
    "unrelated.txt",
  ])
    write(join(pluginRoot, path), "must not ship\n");
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "ego-plugin-packaging-"));
  mkdirSync(join(root, "plugins", "scripts"), { recursive: true });
  copyFileSync(
    join(repositoryRoot, "plugins", "scripts", "package-plugins.mjs"),
    join(root, "plugins", "scripts", "package-plugins.mjs"),
  );
  addPlugin(root, "ego", "1.3.1", "ego-browser");
  addPlugin(root, "sample", "2.4.0", "sample-skill");
  return root;
}
function runPackager(root, args) {
  return spawnSync(
    process.execPath,
    [join(root, "plugins", "scripts", "package-plugins.mjs"), ...args],
    { cwd: root, encoding: "utf8" },
  );
}
function assertSuccess(result) {
  assert.equal(
    result.status,
    0,
    `command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}
function artifactName(name, version, target) {
  return `${name}-${target[0]}-v${version}.${target[2] ? "zip" : "tgz"}`;
}
function unpack(archive, destination) {
  mkdirSync(destination, { recursive: true });
  const npm = archive.endsWith(".tgz");
  assertSuccess(
    spawnSync(
      npm ? "tar" : "unzip",
      npm
        ? ["-xzf", archive, "-C", destination]
        : ["-q", archive, "-d", destination],
      { encoding: "utf8" },
    ),
  );
  return npm ? join(destination, "package") : destination;
}
function files(root, prefix = "") {
  return readdirSync(join(root, prefix))
    .flatMap((name) => {
      const path = join(prefix, name);
      const info = lstatSync(join(root, path));
      assert.equal(
        info.isSymbolicLink(),
        false,
        `${path} must be materialized`,
      );
      return info.isDirectory() ? files(root, path) : [path];
    })
    .sort();
}

function assertArtifacts(root, output, name, version, skillName) {
  const release = join(output, `${name}-v${version}`);
  assert.equal(
    existsSync(release),
    true,
    "packaging must create a version directory with nine host artifacts",
  );
  assert.deepEqual(
    readdirSync(release).sort(),
    targets.map((target) => artifactName(name, version, target)).sort(),
  );
  const extracted = mkdtempSync(join(tmpdir(), "ego-plugin-extracted-"));
  const packages = new Map();
  const sourcePackage = JSON.parse(
    readFileSync(join(root, "plugins", name, "package.json"), "utf8"),
  );
  try {
    for (const target of targets) {
      const [id, title, manifests, marketplacePath] = target;
      const contents = unpack(
        join(release, artifactName(name, version, target)),
        join(extracted, id),
      );
      const plugin = marketplacePath
        ? join(contents, "plugins", name)
        : contents;
      const expected = [
        "LICENSE",
        "README.md",
        ...files(join(root, "skills", skillName)).map(
          (path) => `skills/${skillName}/${path}`,
        ),
      ];
      const readme = readFileSync(join(contents, "README.md"), "utf8");
      assert.ok(readme.includes(title));
      assert.doesNotMatch(readme, /## Development/);
      for (const [, other] of targets)
        if (other !== title)
          assert.ok(
            !readme.includes(`### ${other}\n`),
            "only this host's installation instructions should ship",
          );
      if (manifests) {
        expected.push(
          "plugin.json",
          ...manifests.map((path) => `${path}/plugin.json`),
        );
        for (const path of [
          "plugin.json",
          ...manifests.map((path) => `${path}/plugin.json`),
        ]) {
          const metadata = JSON.parse(readFileSync(join(plugin, path), "utf8"));
          assert.equal(metadata.name, name);
          assert.equal(metadata.version, version);
        }
      } else {
        expected.push(
          "package.json",
          ...(id === "opencode"
            ? ["index.js"]
            : ["cordis.patch.yml", "dsh/src/index.js"]),
        );
        const pkg = JSON.parse(
          readFileSync(join(plugin, "package.json"), "utf8"),
        );
        assert.equal(pkg.name, `${sourcePackage.name}-${id}`);
        assert.equal(pkg.version, version);
        assert.equal(
          pkg.scripts,
          undefined,
          "source lifecycle and development scripts must not ship",
        );
        if (id === "opencode") {
          assert.deepEqual(pkg.exports, {
            ".": "./index.js",
            "./server": "./index.js",
          });
          assert.equal(pkg.dsh, undefined);
        } else {
          assert.deepEqual(pkg.exports, { "./dsh": "./dsh/src/index.js" });
          assert.deepEqual(pkg.dsh, {
            bundle: { patch: "./cordis.patch.yml" },
          });
          assert.ok(
            readFileSync(join(plugin, "cordis.patch.yml"), "utf8").includes(
              `'${pkg.name}/dsh'`,
            ),
          );
        }
        packages.set(id, plugin);
      }
      assert.deepEqual(
        files(plugin),
        expected.sort(),
        `${id} must include only its host entry points and the complete Skill`,
      );
      for (const path of files(join(root, "skills", skillName))) {
        assert.deepEqual(
          readFileSync(join(plugin, "skills", skillName, path)),
          readFileSync(join(root, "skills", skillName, path)),
          `${id}: ${path} must match the canonical Skill`,
        );
      }
      if (marketplacePath) {
        const marketplace = JSON.parse(
          readFileSync(join(contents, marketplacePath), "utf8"),
        );
        assert.equal(marketplace.name, `${name}-${id}-local`);
        assert.equal(marketplace.plugins.length, 1);
        assert.equal(marketplace.plugins[0].name, name);
        if (id === "workbuddy") {
          assert.equal(
            marketplace.description,
            JSON.parse(readFileSync(join(plugin, "plugin.json"), "utf8"))
              .description,
          );
        }
        assert.deepEqual(
          marketplace.plugins[0].source,
          id === "codex"
            ? { source: "local", path: `./plugins/${name}` }
            : `./plugins/${name}`,
        );
        assert.deepEqual(
          files(contents),
          [
            "README.md",
            marketplacePath,
            ...expected.map((path) => `plugins/${name}/${path}`),
          ].sort(),
        );
      }
    }
    if (root === repositoryRoot) {
      assertSuccess(
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        import { EgoBrowserPlugin } from '@citrolabs/ego-opencode/server';
        const config = {};
        await (await EgoBrowserPlugin()).config(config);
        assert.ok(existsSync(config.instructions[0]));
        assert.ok(config.command['ego-browser']);
      `,
          ],
          { cwd: packages.get("opencode"), encoding: "utf8" },
        ),
      );
      assertSuccess(
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import assert from 'node:assert/strict';
        import { existsSync, readFileSync } from 'node:fs';
        const patch = readFileSync('cordis.patch.yml', 'utf8');
        const { apply } = await import(patch.match(/name: '([^']+)'/)[1]);
        let provider;
        apply({ skills: { registerProvider: create => { provider = create(); } } });
        const [candidate] = await provider.list();
        const skill = await provider.get(candidate);
        assert.match(skill.content, /await taskSpace/);
        assert.ok(existsSync(skill.path));
      `,
          ],
          { cwd: packages.get("deepseek-harness"), encoding: "utf8" },
        ),
      );
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

test("one command builds nine independent host packages without changing source links", () => {
  const root = createFixture();
  const output = join(root, "plugins", "ego", "release-output");
  const link = join(root, "plugins", "ego", "skills", "ego-browser");
  const target = readlinkSync(link);
  try {
    write(join(output, "old-artifact.zip"), "keep this existing artifact\n");
    assertSuccess(runPackager(root, ["ego", "--output", output]));
    assertArtifacts(root, output, "ego", "1.3.1", "ego-browser");
    assert.equal(readlinkSync(link), target);
    write(
      join(root, "skills", "ego-browser", "references", "install.md"),
      "updated canonical reference\n",
    );
    assertSuccess(runPackager(root, ["ego", "--output", output]));
    assertArtifacts(root, output, "ego", "1.3.1", "ego-browser");
    assert.equal(readlinkSync(link), target);
    assert.equal(
      readFileSync(join(output, "old-artifact.zip"), "utf8"),
      "keep this existing artifact\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--all creates nine artifacts per plugin in separate version directories", () => {
  const root = createFixture();
  const output = join(root, "release");
  try {
    assertSuccess(runPackager(root, ["--all", "--output", output]));
    assert.deepEqual(readdirSync(output).sort(), [
      "ego-v1.3.1",
      "sample-v2.4.0",
    ]);
    assertArtifacts(root, output, "ego", "1.3.1", "ego-browser");
    assertArtifacts(root, output, "sample", "2.4.0", "sample-skill");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an output directory above plugins does not exclude the plugin itself", () => {
  const root = createFixture();
  try {
    assertSuccess(runPackager(root, ["ego", "--output", root]));
    assertArtifacts(root, root, "ego", "1.3.1", "ego-browser");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing host adapter fails the batch without replacing previous artifacts", () => {
  const root = createFixture();
  const output = join(root, "release");
  try {
    assertSuccess(runPackager(root, ["ego", "--output", output]));
    const release = join(output, "ego-v1.3.1");
    assert.equal(existsSync(release), true);
    const previous = new Map(
      readdirSync(release).map((name) => [
        name,
        readFileSync(join(release, name)),
      ]),
    );
    rmSync(join(root, "plugins", "ego", "dsh", "src", "index.js"));
    write(
      join(root, "skills", "ego-browser", "SKILL.md"),
      "changed after last successful package\n",
    );
    const result = runPackager(root, ["ego", "--output", output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dsh/);
    for (const [name, bytes] of previous)
      assert.deepEqual(readFileSync(join(release, name)), bytes);
    assert.deepEqual(readdirSync(output), ["ego-v1.3.1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const kind of [
  "external-file",
  "missing-skill",
  "different-skill",
  "canonical-child",
  "output-link",
]) {
  test(`${kind} symlinks fail packaging without changing the source`, () => {
    const root = createFixture();
    const output = join(root, "plugins", "ego", "release-output");
    const skillLink = join(root, "plugins", "ego", "skills", "ego-browser");
    try {
      write(join(root, "outside", "secret.txt"), "PRIVATE-DATA\n");
      if (kind === "external-file")
        symlinkSync(
          join(root, "outside", "secret.txt"),
          join(root, "plugins", "ego", "leak.txt"),
        );
      if (kind === "canonical-child")
        symlinkSync(
          join(root, "outside", "secret.txt"),
          join(root, "skills", "ego-browser", "secret.txt"),
        );
      if (kind === "output-link") symlinkSync(join(root, "outside"), output);
      if (kind === "missing-skill" || kind === "different-skill") {
        rmSync(skillLink);
        symlinkSync(
          join(root, kind === "missing-skill" ? "missing" : "outside"),
          skillLink,
        );
      }
      const before = readlinkSync(skillLink);
      const result = runPackager(root, ["ego", "--output", output]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symbolic link|canonical Skill/i);
      assert.equal(readlinkSync(skillLink), before);
      assert.equal(existsSync(join(output, "ego-v1.3.1")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("invalid selectors fail with clear errors", () => {
  const root = createFixture();
  try {
    for (const [args, message] of [
      [["missing"], /unknown plugin.*missing/i],
      [["ego", "--all"], /choose either/i],
      [["ego", "--output"], /requires a directory/i],
    ]) {
      const result = runPackager(root, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the documented npm command builds all nine artifacts with working isolated adapters", () => {
  const output = mkdtempSync(join(tmpdir(), "ego-plugin-npm-"));
  try {
    assertSuccess(
      spawnSync(
        "npm",
        ["--prefix", "plugins/ego", "run", "package", "--", "--output", output],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    );
    const { version } = JSON.parse(
      readFileSync(
        join(repositoryRoot, "plugins", "ego", "plugin.json"),
        "utf8",
      ),
    );
    assertArtifacts(repositoryRoot, output, "ego", version, "ego-browser");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
