import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const guideSource = fileURLToPath(new URL("../skill/", import.meta.url));
const bundledSkill = fileURLToPath(
  new URL("../dist/out/ego-browser/", import.meta.url),
);

test("the bundled guide contains only publishable guide resources", async () => {
  assert.deepEqual((await readdir(bundledSkill)).sort(), [
    "GUIDE.md",
    "learnings",
    "topics",
  ]);
  assert.equal(
    await readFile(join(bundledSkill, "GUIDE.md"), "utf8"),
    await readFile(join(guideSource, "GUIDE.md"), "utf8"),
  );
});

test("the guide CLI is bundled next to the SDK", async () => {
  const outDir = fileURLToPath(new URL("../dist/out/", import.meta.url));
  assert.ok((await readdir(outDir)).includes("skill.js"));
});

test("the published Skill is an entry that defers to the bundled guide", async () => {
  const entryDir = join(repoRoot, "skills/ego-browser");
  const entry = await readFile(join(entryDir, "SKILL.md"), "utf8");

  assert.deepEqual((await readdir(join(entryDir, "references"))).sort(), [
    "install.md",
  ]);
  assert.match(entry, /^ego-browser skill$/m);
  assert.match(entry, /\[ego-browser:skill\] end of guide/);
  assert.doesNotMatch(entry, /taskSpace\(/);
});

test("project Agent and Codex entries share the canonical Skill", async () => {
  for (const directory of [".agents", ".codex"]) {
    assert.equal(
      await readlink(join(repoRoot, directory, "skills/ego-browser")),
      "../../skills/ego-browser",
    );
  }
});
