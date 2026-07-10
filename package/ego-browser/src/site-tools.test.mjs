import test from "node:test";
import assert from "node:assert/strict";

import { searchAndExtract } from "../../../skills/ego-browser/learnings/google/tools/search-extract.js";
import { getBookmarks } from "../../../skills/ego-browser/learnings/x-com/tools/bookmarks.js";
import { getPost } from "../../../skills/ego-browser/learnings/x-com/tools/post.js";
import { searchUsers } from "../../../skills/ego-browser/learnings/x-com/tools/search-users.js";
import { getTimelinePosts } from "../../../skills/ego-browser/learnings/x-com/tools/timeline.js";

test("Node site tools use the Playwright-style helper facades", async () => {
  const opened = [];
  let evaluations = 0;
  const ctx = {
    browser: {
      async openOrReuseTab(url) {
        opened.push(url);
      },
    },
    page: {
      async waitForLoadState() {},
      locator() {
        return {
          async evaluateAll() {
            evaluations += 1;
            return [];
          },
        };
      },
    },
  };

  await searchAndExtract(ctx, { query: "browser agent" });
  await searchUsers(ctx, { query: "openai" });
  await getTimelinePosts(ctx, { maxPosts: 10 });

  assert.equal(opened.length, 2);
  assert.equal(evaluations, 3);
  assert.equal("evaluate" in ctx, false);
  assert.equal("openOrReuseTab" in ctx, false);
});

test("getBookmarks scrolls, deduplicates, and stops at the item limit", async () => {
  const first = post("1", "first");
  const second = post("2", "second");
  const third = post("3", "third");
  const batches = [
    [first, second],
    [second, third],
  ];
  let batchIndex = 0;
  let openedUrl = "";
  const ctx = {
    browser: {
      async openOrReuseTab(url) {
        openedUrl = url;
      },
    },
    page: {
      async url() {
        return "https://x.com/i/bookmarks";
      },
      async evaluate() {},
      locator() {
        return {
          async evaluateAll() {
            return batches[batchIndex];
          },
        };
      },
      mouse: {
        async wheel() {
          batchIndex = Math.min(batchIndex + 1, batches.length - 1);
        },
      },
      async waitForTimeout() {},
    },
  };

  const result = await getBookmarks(ctx, {
    maxPosts: 3,
    maxScrolls: 10,
    waitMs: 100,
  });

  assert.equal(openedUrl, "https://x.com/i/bookmarks");
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    { count: result.count, scrolls: result.scrolls, reason: result.reason },
    { count: 3, scrolls: 1, reason: "limit" },
  );
});

test("getBookmarks reports login redirects instead of an empty collection", async () => {
  const ctx = {
    browser: { async openOrReuseTab() {} },
    page: {
      async url() {
        return "https://x.com/i/flow/login";
      },
    },
  };

  await assert.rejects(() => getBookmarks(ctx), /requires a signed-in session/);
});

test("getBookmarks stops after bounded idle scrolls", async () => {
  const ctx = {
    browser: { async openOrReuseTab() {} },
    page: {
      async url() {
        return "https://x.com/i/bookmarks";
      },
      locator() {
        return {
          async evaluateAll() {
            return [post("1", "only bookmark")];
          },
        };
      },
      mouse: { async wheel() {} },
      async waitForTimeout() {},
    },
  };

  const result = await getBookmarks(ctx, {
    maxPosts: 10,
    maxScrolls: 10,
    idleScrolls: 2,
    fromTop: false,
  });
  assert.deepEqual(
    { count: result.count, scrolls: result.scrolls, reason: result.reason },
    { count: 1, scrolls: 2, reason: "idle" },
  );
});

test("getPost selects the requested status and returns article content", async () => {
  const posts = [post("1", "reply"), post("2", "requested")];
  const article = {
    title: "Long article",
    body: "Article body",
    truncated: false,
    images: [],
  };
  const ctx = {
    browser: { async openOrReuseTab() {} },
    page: {
      async url() {
        return "https://x.com/example/status/2";
      },
      locator() {
        return {
          async evaluateAll() {
            return posts;
          },
        };
      },
      async evaluate() {
        return article;
      },
    },
  };

  const result = await getPost(ctx, {
    url: "https://x.com/example/status/2",
  });
  assert.equal(result.id, "2");
  assert.equal(result.text, "requested");
  assert.deepEqual(result.article, article);
});

test("getPost rejects lookalike non-X hosts", async () => {
  await assert.rejects(
    () =>
      getPost(
        { browser: { async openOrReuseTab() {} } },
        { url: "https://x.com.example.org/user/status/1" },
      ),
    /valid X URL required/,
  );
});

function post(id, text) {
  return {
    id,
    url: `https://x.com/example/status/${id}`,
    text,
    author: "Example",
    handle: "@example",
    timestamp: "2026-07-10T00:00:00.000Z",
    links: [],
  };
}
