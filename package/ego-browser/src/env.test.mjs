import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { resolvePath } from "../dist/src/env.js";

function withHome(home, fn) {
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resolvePath expands ~ against the home directory", () => {
  const home = resolve("/tmp/ego-home");
  withHome(home, () => {
    // Regression: path.slice(1) leaves a leading separator, which resolve()
    // treats as absolute and would drop the home base on every platform.
    assert.equal(
      resolvePath("~/Downloads/a.png"),
      resolve(home, "Downloads/a.png"),
    );
    assert.equal(resolvePath("~"), home);
  });
});

test("resolvePath leaves non-tilde paths to resolve()", () => {
  assert.equal(resolvePath("relative/file.txt"), resolve("relative/file.txt"));
});
