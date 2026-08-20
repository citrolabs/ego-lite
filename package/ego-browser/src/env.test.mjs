import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolvePath, loadEnvFile } from "../dist/src/env.js";

function withHome(home, fn) {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
}

test("resolvePath expands a bare ~ to the home directory", () => {
  withHome("/home/tester", () => {
    assert.equal(resolvePath("~"), "/home/tester");
  });
});

test("resolvePath expands ~/sub to a path under the home directory", () => {
  withHome("/home/tester", () => {
    assert.equal(resolvePath("~/Downloads"), "/home/tester/Downloads");
    assert.equal(resolvePath("~/a/b.env"), "/home/tester/a/b.env");
  });
});

test("resolvePath falls back to USERPROFILE when HOME is unset", () => {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  delete process.env.HOME;
  process.env.USERPROFILE = "/home/winuser";
  try {
    assert.equal(resolvePath("~/Downloads"), "/home/winuser/Downloads");
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
  }
});

test("resolvePath leaves a non-~ path to normal resolution", () => {
  assert.equal(resolvePath("/abs/path"), resolve("/abs/path"));
});

test("resolvePath does not treat ~user as a home shortcut", () => {
  withHome("/home/tester", () => {
    assert.equal(resolvePath("~user/x"), resolve("~user/x"));
  });
});

test("loadEnvFile parses KEY=VALUE, ignores comments/blanks, strips quotes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ego-env-"));
  const file = join(dir, ".env");
  writeFileSync(
    file,
    ["# a comment", "", "FOO=bar", 'QUOTED="hello world"', "SINGLE='x'"].join("\n"),
  );
  const keys = ["FOO", "QUOTED", "SINGLE"];
  const saved = keys.map((k) => [k, process.env[k]]);
  keys.forEach((k) => delete process.env[k]);
  try {
    loadEnvFile(file);
    assert.equal(process.env.FOO, "bar");
    assert.equal(process.env.QUOTED, "hello world");
    assert.equal(process.env.SINGLE, "x");
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFile does not overwrite an already-set variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "ego-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, "PRESET=fromfile\n");
  const prev = process.env.PRESET;
  process.env.PRESET = "preset";
  try {
    loadEnvFile(file);
    assert.equal(process.env.PRESET, "preset");
  } finally {
    if (prev === undefined) delete process.env.PRESET;
    else process.env.PRESET = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFile is a no-op for a missing file", () => {
  assert.doesNotThrow(() => loadEnvFile("/nonexistent/path/.env"));
});
