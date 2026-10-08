import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outDir = fileURLToPath(new URL("../dist/out/", import.meta.url));
const guideSource = fileURLToPath(
  new URL("../skill-body/SKILL.md", import.meta.url),
);

test("the bundled usage guide is the source guide between version and end markers", async () => {
  const bundled = await readFile(join(outDir, "ego-browser/SKILL.md"), "utf8");
  const source = await readFile(guideSource, "utf8");
  const version = /^version: "([^"]+)"$/m.exec(source)[1];
  const lines = bundled.trimEnd().split("\n");

  assert.deepEqual((await readdir(join(outDir, "ego-browser"))).sort(), [
    "SKILL.md",
    "learnings",
  ]);
  assert.equal(
    lines[0],
    `[ego-browser:skill] ego-browser usage guide v${version}`,
  );
  assert.equal(lines.at(-1), `[ego-browser:skill] end of guide v${version}`);
  assert.ok(
    bundled.includes(source.replace(/^---\n[\s\S]*?\n---\n/, "").trim()),
  );
  assert.ok(bundled.length <= 25_000);
});

test("the bundled entry Skill matches the published entry Skill", async () => {
  const entry = join(outDir, "agent-skills/ego-browser");
  assert.deepEqual((await readdir(entry)).sort(), [
    "SKILL.md",
    "agents",
    "assets",
    "references",
    "scripts",
  ]);
  assert.deepEqual((await readdir(join(entry, "references"))).sort(), [
    "clearing-state.md",
    "install.md",
  ]);
  assert.equal(
    await readFile(join(entry, "SKILL.md"), "utf8"),
    await readFile(join(repoRoot, "skills/ego-browser/SKILL.md"), "utf8"),
  );
});

test("the entry Skill defers usage to ego-browser skill", async () => {
  const entry = await readFile(
    join(repoRoot, "skills/ego-browser/SKILL.md"),
    "utf8",
  );
  assert.match(entry, /^\s+bootstrap: true$/m);
  assert.match(entry, /^ego-browser skill$/m);
  assert.match(entry, /\[ego-browser:skill\] end of guide/);
  assert.match(entry, /references\/install\.md/);
  assert.match(entry, /references\/clearing-state\.md/);
});

test("project Agent and Codex entries share the canonical Skill", async () => {
  for (const directory of [".agents", ".codex"]) {
    assert.equal(
      await readlink(join(repoRoot, directory, "skills/ego-browser")),
      "../../skills/ego-browser",
    );
  }
});
