import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeE2eFingerprint,
  readLastPass,
  writeLastPass,
} from "../scripts/real-browser-e2e/fingerprint.mjs";

async function withInputDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "ego-browser-e2e-fingerprint-"));
  try {
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "index.js"), "export const sdk = 1;\n");
    await writeFile(join(dir, "nested", "case.mjs"), "export const c = 1;\n");
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fakeStat = async () => ({ size: 10, mtimeMs: 1000 });

test("real-browser E2E fingerprint is stable for unchanged inputs", async () => {
  await withInputDir(async (dir) => {
    const options = { inputDirs: [dir], cliPath: "/cli", statFile: fakeStat };
    assert.equal(
      await computeE2eFingerprint(options),
      await computeE2eFingerprint(options),
    );
  });
});

test("real-browser E2E fingerprint changes with any input file", async () => {
  await withInputDir(async (dir) => {
    const options = { inputDirs: [dir], cliPath: "/cli", statFile: fakeStat };
    const before = await computeE2eFingerprint(options);
    await writeFile(join(dir, "nested", "case.mjs"), "export const c = 2;\n");
    assert.notEqual(await computeE2eFingerprint(options), before);
  });
});

test("real-browser E2E fingerprint changes when the CLI binary changes", async () => {
  await withInputDir(async (dir) => {
    const before = await computeE2eFingerprint({
      inputDirs: [dir],
      cliPath: "/cli",
      statFile: fakeStat,
    });
    const updatedCli = await computeE2eFingerprint({
      inputDirs: [dir],
      cliPath: "/cli",
      statFile: async () => ({ size: 10, mtimeMs: 2000 }),
    });
    const otherCli = await computeE2eFingerprint({
      inputDirs: [dir],
      cliPath: "/other-cli",
      statFile: fakeStat,
    });
    const missingCli = await computeE2eFingerprint({
      inputDirs: [dir],
      cliPath: "/cli",
      statFile: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.notEqual(updatedCli, before);
    assert.notEqual(otherCli, before);
    assert.notEqual(missingCli, before);
  });
});

test("real-browser E2E last-pass record round-trips and tolerates absence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-browser-e2e-last-pass-"));
  try {
    const recordPath = join(dir, "cache", "last-pass.json");
    assert.equal(await readLastPass(recordPath), null);
    await writeLastPass(recordPath, {
      fingerprint: "abc",
      passedAt: "2026-10-30T00:00:00.000Z",
    });
    assert.deepEqual(await readLastPass(recordPath), {
      fingerprint: "abc",
      passedAt: "2026-10-30T00:00:00.000Z",
    });
    await writeFile(recordPath, "{not json");
    assert.equal(await readLastPass(recordPath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
