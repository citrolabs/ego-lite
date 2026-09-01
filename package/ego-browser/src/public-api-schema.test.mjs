import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_API_SCHEMA,
  publicApiMarkdown,
  validatePublicApiOptions,
} from "../dist/src/public-api-schema.js";

test("the public API schema contains the v2 entry points and object methods", () => {
  const names = new Set(PUBLIC_API_SCHEMA.map((entry) => entry.name));
  for (const name of [
    "profiles",
    "listTaskSpaces",
    "taskSpace",
    "claimTaskSpace",
    "takeOverTaskSpace",
    "TaskSpace.spaceId",
    "TaskSpace.userPage",
    "TaskSpace.pages",
    "TaskSpace.tabs",
    "TaskSpace.newPage",
    "TaskSpace.finish",
    "Page.snapshot",
    "Page.reload",
    "Page.targetId",
    "Page.waitForEvent",
    "Download.page",
    "Download.url",
    "Download.suggestedFilename",
    "Download.saveAs",
    "Download.path",
    "Download.failure",
    "Download.cancel",
    "Download.delete",
    "Page.waitForURL",
    "Page.waitForTimeout",
    "Page.waitForFunction",
    "Page.acceptDialog",
    "Page.dismissDialog",
    "Page.focus",
    "Page.press",
    "Page.selectOption",
    "Page.keyboard.press",
    "Page.keyboard.paste",
  ]) {
    assert(names.has(name), `missing public API schema entry: ${name}`);
  }
  assert.equal(names.has("showTaskState"), false);
  assert.equal(names.has("TaskSpace.listPages"), false);
  assert.equal(names.has("TaskSpace.close"), false);
  assert.equal(names.has("Page.scrollBy"), false);
});

test("schema-driven option validation rejects unknown and invalid fields", () => {
  validatePublicApiOptions("taskSpace", { profileId: "Profile 2" });
  validatePublicApiOptions("Page.click", {
    button: "left",
    clickCount: 2,
    delay: 0,
    force: true,
    timeout: 500,
    label: "open account settings",
  });
  validatePublicApiOptions("Page.mouse.wheel", {
    label: "scroll project board",
  });
  validatePublicApiOptions("Page.fetch", { saveAs: "/tmp/image.png" });
  validatePublicApiOptions("Page.screenshot", {
    path: "/tmp/image.png",
    scale: "css",
  });
  validatePublicApiOptions("TaskSpace.finish", { keep: [] });
  validatePublicApiOptions("TaskSpace.finish", { keep: ["p2"] });
  validatePublicApiOptions("TaskSpace.finish", { keep: "all" });
  for (const waitUntil of [
    "commit",
    "domcontentloaded",
    "load",
    "networkidle",
  ]) {
    validatePublicApiOptions("Page.goto", {
      referer: "https://example.test/source",
      waitUntil,
    });
  }

  assert.throws(
    () => validatePublicApiOptions("taskSpace", { profileId: "" }),
    /taskSpace profileId must be a non-empty string/,
  );
  assert.throws(
    () => validatePublicApiOptions("Page.click", { trial: true }),
    /unknown option: trial\. Expected: await page\.click\(selector, \{ button\?, clickCount\?, delay\?, position\?, force\?, timeout\?, label\? \}\)/,
  );
  assert.throws(
    () => validatePublicApiOptions("Page.screenshot", { scale: "invalid" }),
    /scale must be one of css/,
  );
  assert.throws(
    () => validatePublicApiOptions("Page.screenshot", { scale: "device" }),
    /scale must be one of css/,
  );
  assert.throws(
    () => validatePublicApiOptions("Page.goto", { timeout: 0 }),
    /timeout must be a positive number of milliseconds/,
  );
  assert.throws(
    () => validatePublicApiOptions("Page.goto", { waitUntil: "interactive" }),
    /waitUntil must be one of commit, domcontentloaded, load, networkidle/,
  );
  assert.throws(
    () => validatePublicApiOptions("Page.waitForFunction", { polling: 0 }),
    /polling must be a positive number of milliseconds/,
  );
  assert.throws(
    () => validatePublicApiOptions("Page.click", { button: "primary" }),
    /button must be one of left, middle, right/,
  );
  assert.throws(
    () => validatePublicApiOptions("TaskSpace.finish", { keep: true }),
    /keep must be "all" or an array of unique non-empty Page labels/,
  );
  assert.throws(
    () => validatePublicApiOptions("TaskSpace.finish", { keep: ["p2", "p2"] }),
    /keep must be "all" or an array of unique non-empty Page labels/,
  );
});

test("the generated reference contains signatures and option descriptions", () => {
  const markdown = publicApiMarkdown();
  assert.match(markdown, /`await profiles\(\)`/);
  assert.doesNotMatch(markdown, /`await showTaskState\(state\)`/);
  assert.match(
    markdown,
    /`await page\.click\(selector, \{ button\?, clickCount\?, delay\?, position\?, force\?, timeout\?, label\? \}\)`/,
  );
  assert.match(markdown, /`label`.*user-visible action description/);
  assert.match(markdown, /`await listTaskSpaces\(\)`/);
  assert.match(markdown, /`await taskSpace\(nameOrId, \{ profileId\? \}\)`/);
  assert.match(markdown, /a new space starts with managed Page p1/);
  assert.match(markdown, /`await task\.newPage\(\)`/);
  assert.match(
    markdown,
    /`await task\.finish\(\{ keep \}\)`.*keep selected managed Pages/,
  );
  assert.doesNotMatch(markdown, /task\.close/);
  assert.match(
    markdown,
    /`await page\.goto\(url, \{ referer\?, timeout\?, waitUntil\? \}\)`/,
  );
  assert.match(
    markdown,
    /`await page\.reload\(\{ timeout\?, waitUntil\? \}\)`/,
  );
  assert.match(
    markdown,
    /`await page\.selectOption\(selector, valueOrValues, \{ timeout\? \}\)`/,
  );
  assert.match(
    markdown,
    /`await page\.waitForEvent\(event, \{ timeout\? \}\)`.*"popup" or "download"/,
  );
  assert.match(
    markdown,
    /`await page\.waitForURL\(urlMatcher, \{ timeout\? \}\)`.*Playwright-style glob.*predicate receiving a URL object/,
  );
  assert.match(
    markdown,
    /`await page\.waitForFunction\(fnOrString, argument\?, \{ timeout\?, polling\? \}\)`/,
  );
  assert.match(
    markdown,
    /`await page\.keyboard\.press\(chord, \{ delay\? \}\)`.*Named keys are case-insensitive.*single-character keys preserve case/,
  );
  assert.match(
    markdown,
    /const downloadPromise = page\.waitForEvent\("download"\); await page\.click\(selector\)/,
  );
  assert.match(markdown, /page\.acceptDialog\(promptText\?\)/);
  assert.match(markdown, /page\.dismissDialog\(\)/);
  assert.doesNotMatch(markdown, /Page\.handleJavaScriptDialog/);
  assert.match(markdown, /no state defaults to load/);
  assert.match(markdown, /value-or-label string/);
  assert.match(markdown, /\{ value\?, label\?, index\? \}/);
  assert.match(markdown, /terminal `:has-text\("\.\.\."\)`/);
  assert.match(markdown, /`loc=role:\.\.\.\[name\*="\.\.\."\]`/);
  assert.doesNotMatch(markdown, /task\.openPage/);
  assert.match(markdown, /Create and durably label a blank Page/);
  assert.match(
    markdown,
    /Maximum wait for the element to become usable in milliseconds; defaults to 3000/,
  );
  assert.match(markdown, /missing parent directories are created/);
});
