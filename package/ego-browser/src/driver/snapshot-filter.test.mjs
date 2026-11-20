import test from "node:test";
import assert from "node:assert/strict";

import { filterSnapshotContent } from "../../dist/src/driver/snapshot-filter.js";
import { snapshotText, snapshotRaw } from "../../dist/src/driver/observe.js";
import { invalidateSession } from "../../dist/src/browser-runtime.js";

// Mirrors the public snapshot grammar: the role is the leading token, names are
// quoted, and metadata lives in a trailing bracket that may contain nested
// brackets from `loc=css:a[...]`.
const SAMPLE_SNAPSHOT = `[p1 "Example Shop" | space 1478x1344 | scroll 0,0]
  container [ref=1]
    banner "Site header" [ref=2, loc=role:banner, url=https://example.com/header?utm_source=nav]
    anchor "Home" [ref=10, loc=css:a[aria-label="Home page"], url=https://example.com/home?session=abc123]
    anchor "mirror url=https://tracker.example/pixel" [ref=11, loc=role:link, url=https://example.com/mirror?ref=nav]
    button "Add to cart" [ref=42, loc=role:button[name="Add to cart"], url=https://example.com/cart/add?sku=1&utm=mail]
    textbox "Search" [ref=55, loc=role:textbox[name="Search"]]
    heading "Featured products" [ref=5]
    text "Static paragraph about shipping"
    text "Static ad: Buy now and save 50%"
    checkbox "Subscribe" [ref=60, loc=role:checkbox[name="Subscribe"], url=https://example.com/subscribe]
[more content below the viewport — scroll to reveal]`;

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

test("filterSnapshotContent interactiveOnly matches the leading role token", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, {
    interactiveOnly: true,
  });
  assert.match(filtered, /\[p1 "Example Shop"/);
  assert.match(filtered, /anchor "Home"/);
  assert.match(filtered, /button "Add to cart"/);
  assert.match(filtered, /textbox "Search"/);
  assert.match(filtered, /heading "Featured products"/);
  assert.match(filtered, /checkbox "Subscribe"/);
  assert.match(filtered, /banner "Site header"/);
  assert.match(filtered, /more content below the viewport/);
  assert.doesNotMatch(filtered, /Static paragraph/);
  assert.doesNotMatch(filtered, /Static ad/);
});

test("filterSnapshotContent roles keeps only matching roles", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, {
    roles: ["button", "link"],
  });
  assert.match(filtered, /\[p1 "Example Shop"/);
  assert.match(filtered, /anchor "Home"/);
  assert.match(filtered, /button "Add to cart"/);
  assert.doesNotMatch(filtered, /textbox "Search"/);
  assert.doesNotMatch(filtered, /checkbox "Subscribe"/);
  assert.doesNotMatch(filtered, /heading "Featured products"/);
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

test("filterSnapshotContent maxChars truncates at a line boundary and keeps hints", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, { maxChars: 120 });
  assert.match(filtered, /… truncated \(\d+ chars omitted for maxChars=120\)$/);
  assert.match(filtered, /more content below the viewport/);
  for (const line of filtered.split("\n").slice(0, -1)) {
    assert.equal(
      (line.match(/\[/g) || []).length,
      (line.match(/\]/g) || []).length,
      `unbalanced brackets in kept line: ${line}`,
    );
  }
});

test("filterSnapshotContent urls: none drops url metadata only", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, { urls: "none" });
  assert.match(filtered, /Static paragraph about shipping/);
  assert.match(
    filtered,
    /anchor "Home" \[ref=10, loc=css:a\[aria-label="Home page"\]\]/,
  );
  assert.match(filtered, /mirror url=https:\/\/tracker\.example\/pixel/);
  assert.doesNotMatch(filtered, /url=https:\/\/example\.com/);
});

test("filterSnapshotContent urls: host_path keeps origin and pathname", () => {
  const filtered = filterSnapshotContent(SAMPLE_SNAPSHOT, {
    urls: "host_path",
  });
  assert.match(filtered, /url=https:\/\/example\.com\/home/);
  assert.match(filtered, /url=https:\/\/example\.com\/cart\/add/);
  assert.doesNotMatch(filtered, /session=abc123|utm_source=nav|sku=1/);
  assert.match(filtered, /mirror url=https:\/\/tracker\.example\/pixel/);
});

test("filterSnapshotContent strips url metadata without touching quoting", () => {
  const content = `  anchor "Docs" [ref=1, loc=role:link, url="https://example.com/a?b=1"]`;
  const filtered = filterSnapshotContent(content, { urls: "none" });
  assert.equal(filtered, `  anchor "Docs" [ref=1, loc=role:link]`);
});

test("filterSnapshotContent still understands legacy role= metadata", () => {
  const legacy = `Page: Legacy
URL: https://example.com/
  banner "Site header" [ref=1, loc=role:banner]
  button "Add to cart" [ref=42, loc=role:button]
  Static ad`;
  const filtered = filterSnapshotContent(legacy, { interactiveOnly: true });
  assert.match(filtered, /Page: Legacy/);
  assert.match(filtered, /banner "Site header"/);
  assert.match(filtered, /button "Add to cart"/);
  assert.doesNotMatch(filtered, /Static ad/);
});

test("filterSnapshotContent returns content unchanged when no filters set", () => {
  assert.equal(filterSnapshotContent(SAMPLE_SNAPSHOT), SAMPLE_SNAPSHOT);
  assert.equal(filterSnapshotContent(""), "");
});

test("snapshotText applies interactiveOnly filter to text output", async () => {
  await withSnapshotEgo(SAMPLE_SNAPSHOT, async () => {
    const text = await snapshotText({ interactiveOnly: true });
    assert.match(text, /button "Add to cart"/);
    assert.doesNotMatch(text, /Static ad/);
  });
});

test("snapshotRaw filters content but preserves refs", async () => {
  await withSnapshotEgo(SAMPLE_SNAPSHOT, async () => {
    const raw = await snapshotRaw({ roles: ["link"] });
    assert.match(raw.content, /anchor "Home"/);
    assert.doesNotMatch(raw.content, /button "Add to cart"/);
    assert.equal(raw.refs.length, 4);
  });
});

test("snapshotText passes ego options without filter keys", async () => {
  let receivedOptions;
  const previous = globalThis.ego;
  globalThis.ego = {
    async snapshot(options) {
      receivedOptions = options;
      return {
        content:
          '  anchor "Home" [ref=1, loc=role:link, url=https://example.com/?q=1]',
        refs: [],
      };
    },
  };
  invalidateSession();
  try {
    const text = await snapshotText({
      scope: "only_within_viewport",
      includeActionMarks: false,
      interactiveOnly: true,
      maxChars: 100,
      urls: "none",
    });
    assert.deepEqual(receivedOptions, {
      scope: "only_within_viewport",
      includeActionMarks: false,
      includeStableLocator: true,
    });
    assert.doesNotMatch(text, /url=/);
  } finally {
    invalidateSession();
    if (previous === undefined) {
      delete globalThis.ego;
    } else {
      globalThis.ego = previous;
    }
  }
});
