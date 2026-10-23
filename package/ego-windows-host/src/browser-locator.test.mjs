import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { candidatePaths, locateBrowser } from "../dist/src/browser-locator.js";

const ENV = {
  PROGRAMFILES: join("C:", "Program Files"),
  "PROGRAMFILES(X86)": join("C:", "Program Files (x86)"),
  LOCALAPPDATA: join("C:", "Users", "agent", "AppData", "Local"),
};

const EDGE_X86 = join(
  ENV["PROGRAMFILES(X86)"],
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);
const CHROME = join(
  ENV.PROGRAMFILES,
  "Google",
  "Chrome",
  "Application",
  "chrome.exe",
);

test("locateBrowser prefers the EGO_HOST_BROWSER_PATH override", () => {
  const override = join("D:", "browsers", "chrome.exe");
  const result = locateBrowser({
    env: { ...ENV, EGO_HOST_BROWSER_PATH: override },
    exists: (path) => path === override,
  });
  assert.equal(result, override);
});

test("locateBrowser rejects a missing override instead of falling back", () => {
  assert.throws(
    () =>
      locateBrowser({
        env: { ...ENV, EGO_HOST_BROWSER_PATH: join("D:", "missing.exe") },
        exists: () => false,
      }),
    /EGO_HOST_BROWSER_PATH does not exist/,
  );
});

test("locateBrowser finds Edge before Chrome", () => {
  const result = locateBrowser({
    env: ENV,
    exists: (path) => path === EDGE_X86 || path === CHROME,
  });
  assert.equal(result, EDGE_X86);
});

test("locateBrowser falls back to Chrome when Edge is absent", () => {
  const result = locateBrowser({
    env: ENV,
    exists: (path) => path === CHROME,
  });
  assert.equal(result, CHROME);
});

test("locateBrowser explains how to configure when nothing is found", () => {
  assert.throws(
    () => locateBrowser({ env: ENV, exists: () => false }),
    /EGO_HOST_BROWSER_PATH/,
  );
});

test("candidatePaths covers every root for every browser", () => {
  const candidates = candidatePaths(ENV);
  assert.equal(candidates.length, 9);
  assert.ok(candidates.includes(EDGE_X86));
  assert.ok(candidates.includes(CHROME));
});
