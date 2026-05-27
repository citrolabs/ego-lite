import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(root, "artifacts", "ego-browser", "index.js");

test("build artifact exists as a single executable JavaScript file", async () => {
  const info = await stat(artifactPath);
  assert.equal(info.isFile(), true);
  assert.ok(info.size > 10_000);
  await access(artifactPath, constants.X_OK);

  const source = await readFile(artifactPath, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env node\n/);
  assert.equal(source.includes("\n#!/usr/bin/env node"), false);
});

test("build artifact runs help and stdin scripts directly", () => {
  const help = spawnSync(process.execPath, [artifactPath, "--help"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ego-browser/);
  assert.match(help.stdout, /Helpers are pre-imported/);

  const stdin = spawnSync(process.execPath, [artifactPath], {
    cwd: root,
    input: "cliLog('artifact-ok', typeof pageInfo)\n",
    encoding: "utf8"
  });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(stdin.stdout, "artifact-ok function\n");
});

test("build output is isolated from legacy root and bin paths", async () => {
  await assert.rejects(access(join(root, "ego-browser.js")));
  await assert.rejects(access(join(root, "bin")));
});

test("package bin metadata points at the generated artifact", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));

  assert.deepEqual(pkg.bin, { index: "./artifacts/ego-browser/index.js" });
  assert.deepEqual(lock.packages[""].bin, { index: "artifacts/ego-browser/index.js" });
  await access(join(root, pkg.bin.index));
});

test("npm pack includes the generated bin artifact", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const packs = JSON.parse(result.stdout);
  const files = packs[0].files.map((file) => file.path);

  assert.ok(files.includes("artifacts/ego-browser/index.js"));
  assert.ok(files.includes("package.json"));
});
