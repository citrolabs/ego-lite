import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../../scripts/sync-skills.mjs", import.meta.url),
);

function write(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

// A commit hook runs these tests with GIT_INDEX_FILE pointing at the commit's
// index, so the fixture repository must not inherit Git's environment.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

test("--staged copies only what the commit stages and stages the copy", () => {
  const root = mkdtempSync(join(tmpdir(), "ego-skill-sync-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", env });
  try {
    mkdirSync(join(root, "plugins", "scripts"), { recursive: true });
    copyFileSync(script, join(root, "plugins", "scripts", "sync-skills.mjs"));
    for (const base of ["skills/demo", "plugins/p/skills/demo"]) {
      write(root, `${base}/SKILL.md`, "v1\n");
      write(root, `${base}/old.md`, "old\n");
    }
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

    write(root, "skills/demo/SKILL.md", "v2 staged\n");
    git("add", "skills/demo/SKILL.md");
    git("rm", "-q", "skills/demo/old.md");
    write(root, "skills/demo/SKILL.md", "v3 unstaged\n");
    write(root, "skills/demo/draft.md", "untracked\n");

    execFileSync(
      process.execPath,
      [join(root, "plugins", "scripts", "sync-skills.mjs"), "p", "--staged"],
      { env },
    );

    assert.equal(git("show", ":plugins/p/skills/demo/SKILL.md"), "v2 staged\n");
    assert.equal(
      readFileSync(join(root, "plugins/p/skills/demo/SKILL.md"), "utf8"),
      "v2 staged\n",
    );
    assert.deepEqual(
      git("ls-files", "plugins/p/skills").trim().split("\n"),
      ["plugins/p/skills/demo/SKILL.md"],
      "the staged deletion propagates and the untracked draft stays out",
    );
    assert.equal(
      readFileSync(join(root, "skills/demo/SKILL.md"), "utf8"),
      "v3 unstaged\n",
      "the canonical working tree is left alone",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
