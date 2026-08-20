import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { resolvePath } from "../dist/src/env.js";

test("resolvePath expands ~ relative to the home directory", () => {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const home =
    process.platform === "win32" ? "C:\\Users\\ego-test" : "/home/ego-test";
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    // "~/ws" must land inside home, not be dropped to an absolute "/ws".
    assert.equal(resolvePath("~/workspace"), resolve(join(home, "workspace")));
    assert.equal(resolvePath("~"), resolve(home));
    assert.equal(resolvePath("~/a/b"), resolve(join(home, "a", "b")));
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    if (prevProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = prevProfile;
    }
  }
});

test("resolvePath resolves a non-tilde path to an absolute path", () => {
  assert.equal(resolvePath("some/rel/dir"), resolve("some/rel/dir"));
});
