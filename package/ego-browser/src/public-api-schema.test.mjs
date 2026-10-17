import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_API_SCHEMA,
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
  validatePublicApiOptions("Page.snapshot", {
    scope: "subtree",
    root: "@21",
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
    () => validatePublicApiOptions("Page.snapshot", { root: 21 }),
    /root must be a non-empty string/,
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
