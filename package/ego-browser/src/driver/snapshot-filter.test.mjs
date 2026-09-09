import test from "node:test";
import assert from "node:assert/strict";

import { filterSnapshotContent } from "../../dist/src/driver/snapshot-filter.js";
import { snapshot, snapshotRaw } from "../../dist/src/driver/observe.js";
import { invalidateSession } from "../../dist/src/browser-runtime.js";

const SAMPLE_SNAPSHOT = `Page: Example Shop
URL: https://example.com/shop
  Static paragraph about shipping
  banner "Site header" [ref=1, loc=role:banner]
  link "Home" [ref=10, loc=role:link[name="Home"]]
  button "Add to cart" [ref=42, loc=role:button[name="Add to cart"]]
  textbox "Search" [ref=55, loc=role:textbox[name="Search"]]
  heading "Featured products" [ref=5, loc=role:heading[name="Featured products"]]
  Static ad: Buy now and save 50%
  checkbox "Subscribe" [ref=60, loc=role:checkbox[name="Subscribe"]]`;

function withSnapshotEgo(content, fn) {
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot() {
      return {
        content,
        refs: [
          { backendNodeId: 10, role: "link", name: "Home" },
          { backendNodeId: 42, role: "button", name: "Add to cart" },
          { backendNodeId: 55, role: "textbox", name: "Search" },
          { backendNodeId: 60, role: "checkbox", name: "Subscribe" },
        ],
      };
    },
  };
  invalidateSession();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      invalidateSession();
      if (previous === undefined) {
        delete globalThis.ego;
      } else {
        globalThis.ego = previous;
      }
    });
}

test("filterSnapshotContent interactiveOnly keeps interactive and heading refs", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, {
    interactiveOnly: true,
  });
  assert.match(filtered, /Page: Example Shop/);
  assert.match(filtered, /URL: https:\/\/example.com\/shop/);
  assert.match(filtered, /link "Home"/);
  assert.match(filtered, /button "Add to cart"/);
  assert.match(filtered, /textbox "Search"/);
  assert.match(filtered, /heading "Featured products"/);
  assert.match(filtered, /checkbox "Subscribe"/);
  assert.match(filtered, /banner "Site header"/);
  assert.doesNotMatch(filtered, /Static paragraph/);
  assert.doesNotMatch(filtered, /Static ad/);
});

test("filterSnapshotContent roles keeps only matching roles", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, {
    roles: ["button", "link"],
  });
  assert.match(filtered, /Page: Example Shop/);
  assert.match(filtered, /link "Home"/);
  assert.match(filtered, /button "Add to cart"/);
  assert.doesNotMatch(filtered, /textbox "Search"/);
  assert.doesNotMatch(filtered, /checkbox "Subscribe"/);
});

test("filterSnapshotContent match string is case-insensitive", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, {
    match: "ADD TO",
  });
  assert.match(filtered, /button "Add to cart"/);
  assert.equal(filtered.split("\n").length, 3);
});

test("filterSnapshotContent match regex keeps matching lines", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, {
    match: /textbox|checkbox/i,
  });
  assert.match(filtered, /textbox "Search"/);
  assert.match(filtered, /checkbox "Subscribe"/);
  assert.doesNotMatch(filtered, /button "Add to cart"/);
});

test("filterSnapshotContent maxChars truncates with omission note", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, { maxChars: 40 });
  assert.ok(filtered.length > 40);
  assert.match(filtered, /… truncated \(\d+ chars omitted for maxChars=40\)$/);
});

test("filterSnapshotContent returns content unchanged when no filters set", () => {
  assert.equal(filterSnapshotContent(SAMPLE_SNAPSHOT), SAMPLE_SNAPSHOT);
  assert.equal(filterSnapshotContent(""), "");
});

test("snapshot applies interactiveOnly filter to text output", async () => {
  await withSnapshotEgo(SAMPLE_SNAPSHOT, async () => {
    const text = await snapshot({ interactiveOnly: true });
    assert.match(text, /button "Add to cart"/);
    assert.doesNotMatch(text, /Static ad/);
  });
});

test("snapshotRaw filters content but preserves refs", async () => {
  await withSnapshotEgo(SAMPLE_SNAPSHOT, async () => {
    const raw = await snapshotRaw({ roles: ["link"] });
    assert.match(raw.content, /link "Home"/);
    assert.doesNotMatch(raw.content, /button "Add to cart"/);
    assert.equal(raw.refs.length, 4);
  });
});

test("snapshot passes ego options without filter keys", async () => {
  let receivedOptions;
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot(options) {
      receivedOptions = options;
      return {
        content: "Page: Test\n  button [ref=1, loc=role:button]",
        refs: [],
      };
    },
  };
  invalidateSession();
  try {
    await snapshot({
      scope: "only_within_viewport",
      includeActionMarks: false,
      interactiveOnly: true,
      maxChars: 100,
    });
    assert.deepEqual(receivedOptions, {
      scope: "only_within_viewport",
      includeActionMarks: false,
      includeStableLocator: true,
    });
  } finally {
    invalidateSession();
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
});
