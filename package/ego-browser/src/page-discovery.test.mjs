import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeUnhandledPageNotices,
  markPageObserved,
  peekUnhandledPageNotices,
  recordUnhandledPage,
  resetPageNotices,
  subscribeUnhandledPageNotices,
} from "../dist/src/page-discovery.js";

test("page discovery merges updates and notifies subscribers", () => {
  resetPageNotices();
  const delivered = [];
  const unsubscribe = subscribeUnhandledPageNotices((notice) =>
    delivered.push(notice),
  );

  recordUnhandledPage({
    spaceId: 7,
    targetId: "popup",
    label: "p2",
    openerLabel: "p1",
    url: "about:blank",
  });
  recordUnhandledPage({
    spaceId: 7,
    targetId: "popup",
    label: "p2",
    url: "https://example.test/popup",
  });
  unsubscribe();

  assert.equal(delivered.length, 2);
  assert.deepEqual(peekUnhandledPageNotices(), [
    {
      spaceId: 7,
      targetId: "popup",
      label: "p2",
      openerLabel: "p1",
      url: "https://example.test/popup",
    },
  ]);
});

test("observed and consumed page notices do not reappear", () => {
  resetPageNotices();
  recordUnhandledPage({ spaceId: 7, targetId: "a", label: "p2" });
  recordUnhandledPage({ spaceId: 7, targetId: "b", label: "p3" });

  markPageObserved(7, "a");
  assert.deepEqual(
    consumeUnhandledPageNotices().map((notice) => notice.targetId),
    ["b"],
  );
  assert.deepEqual(consumeUnhandledPageNotices(), []);

  recordUnhandledPage({ spaceId: 7, targetId: "a", label: "p2" });
  assert.deepEqual(peekUnhandledPageNotices(), []);
});
