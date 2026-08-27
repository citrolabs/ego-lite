import test from "node:test";
import assert from "node:assert/strict";

import {
  MACOS_EGO_LITE_CLI,
  resolveEgoBrowserCli,
} from "../scripts/real-browser-e2e/ego-browser-cli.mjs";
import { pageScrolledScreenshotCase } from "../scripts/real-browser-e2e/cases/page-screenshot.mjs";
import { parseOnlyCases } from "../scripts/real-browser-e2e/runner.mjs";

test("real-browser E2E honors an explicit Ego Lite CLI", () => {
  assert.equal(
    resolveEgoBrowserCli({
      configured: "/custom/ego-lite/ego-browser",
      platform: "darwin",
      pathExists: () => true,
    }),
    "/custom/ego-lite/ego-browser",
  );
});

test("real-browser E2E prefers the stable Ego Lite app path on macOS", () => {
  assert.equal(
    resolveEgoBrowserCli({
      configured: "",
      platform: "darwin",
      pathExists: (path) => path === MACOS_EGO_LITE_CLI,
    }),
    MACOS_EGO_LITE_CLI,
  );
});

test("real-browser E2E falls back to PATH when no app-specific CLI exists", () => {
  assert.equal(
    resolveEgoBrowserCli({
      platform: "linux",
      pathExists: () => false,
    }),
    "ego-browser",
  );
});

test("real-browser E2E selects an exact case name that contains commas", () => {
  assert.deepEqual(
    [
      ...parseOnlyCases("wait, fetch, cdp, js, help", [
        "wait, fetch, cdp, js, help",
        "Page API alignment",
      ]),
    ],
    ["wait, fetch, cdp, js, help"],
  );
});

test("real-browser E2E accepts a JSON array for multiple exact case names", () => {
  assert.deepEqual(
    [
      ...parseOnlyCases(
        '["wait, fetch, cdp, js, help", "Page API alignment"]',
        ["wait, fetch, cdp, js, help", "Page API alignment"],
      ),
    ],
    ["wait, fetch, cdp, js, help", "Page API alignment"],
  );
});

test("real-browser E2E keeps legacy comma-separated case selection", () => {
  assert.deepEqual(
    [
      ...parseOnlyCases("first case, second case", [
        "first case",
        "second case",
      ]),
    ],
    ["first case", "second case"],
  );
});

test("real-browser E2E rejects unknown selected cases instead of skipping all", () => {
  assert.throws(
    () => parseOnlyCases("Page API aligment", ["Page API alignment"]),
    /unknown real-browser E2E case.*Page API aligment.*Page API alignment/i,
  );
});

test("real-browser E2E rejects an explicitly empty selection", () => {
  assert.throws(
    () => parseOnlyCases("[]", ["Page API alignment"]),
    /must select at least one/i,
  );
});

test("the scrolled screenshot fixture is larger than the live viewport", () => {
  const source = pageScrolledScreenshotCase();

  assert.match(source, /viewportWidth \+ 1000/);
  assert.match(source, /viewportHeight \+ 100/);
  assert.match(source, /scrollPosition\.x > 0 && scrollPosition\.y > 0/);
});

test("the scrolled screenshot case closes its managed Page from finally", () => {
  assert.match(
    pageScrolledScreenshotCase(),
    /try\s*\{[\s\S]*\}\s*finally\s*\{\s*await page\.close\(\)/,
  );
});
