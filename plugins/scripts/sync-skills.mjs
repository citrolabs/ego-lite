#!/usr/bin/env node

// Hosts that install a plugin straight from Git drop links that leave the
// plugin root, so each plugin keeps a copy of the canonical Skills it ships.
//
// --staged copies the Skills as staged in the Git index and stages the copy,
// so a commit hook never picks up unstaged edits or untracked drafts.
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const [name, mode] = process.argv.slice(2);
if (!name || (mode && mode !== "--staged")) {
  console.error(
    "Usage: node plugins/scripts/sync-skills.mjs <plugin> [--staged]",
  );
  process.exit(1);
}
const staged = mode === "--staged";

function git(args, input) {
  return execFileSync("git", args, { cwd: repositoryRoot, input });
}

const exportRoot = staged
  ? await mkdtemp(join(tmpdir(), "ego-skill-sync-"))
  : undefined;
try {
  const skillsRoot = join(repositoryRoot, "plugins", name, "skills");
  for (const skill of await readdir(skillsRoot)) {
    if (skill.startsWith(".")) continue;
    const canonical = `skills/${skill}`;
    if (staged) {
      git(
        ["checkout-index", `--prefix=${exportRoot}/`, "-z", "--stdin"],
        git(["ls-files", "-z", "--", canonical]),
      );
    }
    const copy = join(skillsRoot, skill);
    await rm(copy, { recursive: true, force: true });
    await cp(join(staged ? exportRoot : repositoryRoot, canonical), copy, {
      recursive: true,
    });
    if (staged) git(["add", "-A", "--", copy]);
    console.log(`Synced ${canonical} -> plugins/${name}/skills/${skill}`);
  }
} finally {
  if (exportRoot) await rm(exportRoot, { recursive: true, force: true });
}
