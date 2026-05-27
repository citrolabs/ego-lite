import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(root, ".build.lock");

test("build fails clearly when another build lock exists", async () => {
  await writeFile(lockPath, "test lock");
  try {
    const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another ego-browser-v2 build is already running/);
  } finally {
    await rm(lockPath, { force: true });
  }
});
