#!/usr/bin/env node
// Removes build output. Kept in Node rather than `rm -rf` because npm runs
// package scripts through cmd.exe on Windows, which has no `rm`.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const target of ["dist", "artifacts"]) {
  rmSync(join(packageDir, target), { recursive: true, force: true });
}
