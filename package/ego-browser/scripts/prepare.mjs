#!/usr/bin/env node
// Installs the repository git hooks after a local `npm install`.
// Kept in Node rather than inline shell because npm runs package scripts through
// cmd.exe on Windows, where POSIX `if [ ... ]` syntax is a syntax error.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

if (process.env.CI === "true") {
  process.exit(0);
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "..", "..");
const lefthook = join(
  packageDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "lefthook.cmd" : "lefthook",
);

const result = spawnSync(lefthook, ["install"], {
  cwd: repoRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 0);
