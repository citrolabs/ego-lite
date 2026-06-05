import test from "node:test";
import assert from "node:assert/strict";

import { listTabs, newTab } from "../../dist/src/driver/nav.js";

function withEgo(ego, fn) {
  const previous = globalThis.ego;
  globalThis.ego = ego;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("listTabs throws on ego binding error objects", async () => {
  await withEgo({
    async listTabs() {
      return { error: "The task is under user control" };
    }
  }, async () => {
    await assert.rejects(
      () => listTabs(),
      /listTabs: The task is under user control/
    );
  });
});

test("newTab throws on ego binding error objects", async () => {
  await withEgo({
    async createTab() {
      return { error: "The task is under user control" };
    }
  }, async () => {
    await assert.rejects(
      () => newTab("https://example.com/"),
      /newTab: The task is under user control/
    );
  });
});

test("newTab throws when the binding returns no targetId", async () => {
  await withEgo({
    async createTab() {
      return {};
    }
  }, async () => {
    await assert.rejects(
      () => newTab("https://example.com/"),
      /newTab returned no targetId/
    );
  });
});
