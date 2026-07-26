import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  loadLearnedContext,
  runNodeSiteTool,
  validateLearning,
} from "../../dist/src/learning/index.js";

const packagedDir = fileURLToPath(
  new URL(
    "../../../../skills/ego-browser/learnings/hacker-news",
    import.meta.url,
  ),
);

// Copy the packaged learning into a temp workspace so the suite runs
// independently of any package.json module scope above the repository.
async function tempLearningsRoot() {
  const root = await mkdtemp(join(tmpdir(), "ego-hn-learning-"));
  await cp(packagedDir, join(root, "hacker-news"), { recursive: true });
  return root;
}

function stubCtx(evaluateResults = {}) {
  const opened = [];
  return {
    opened,
    browser: {
      openOrReuseTab: async (url) => {
        opened.push(url);
      },
    },
    page: {
      waitForLoadState: async () => {},
      locator: (selector) => ({
        evaluateAll: async () => evaluateResults[selector] ?? [],
      }),
    },
  };
}

test("hacker-news learning pack passes format validation", async () => {
  const root = await tempLearningsRoot();
  assert.deepEqual(await validateLearning(join(root, "hacker-news")), []);
});

test("loadLearnedContext surfaces hacker-news tools for item URLs", async () => {
  const root = await tempLearningsRoot();
  const context = await loadLearnedContext(
    "https://news.ycombinator.com/item?id=1",
    { root },
  );

  assert.equal(context.exists, true);
  assert.equal(context.siteId, "hacker-news");
  const toolNames = context.tools.map((tool) => tool.toolName);
  assert.deepEqual(toolNames.sort(), [
    "extract_comments",
    "get_item",
    "get_posts",
    "search_posts",
  ]);
});

test("get_posts falls back to the news feed and bounds the page number", async () => {
  const root = await tempLearningsRoot();
  const ctx = stubCtx();

  await runNodeSiteTool(
    "hacker-news",
    "get_posts",
    { feed: "ask", page: 2 },
    ctx,
    { root },
  );
  await runNodeSiteTool(
    "hacker-news",
    "get_posts",
    { feed: "jobs-invalid", page: 0 },
    ctx,
    { root },
  );

  assert.deepEqual(ctx.opened, [
    "https://news.ycombinator.com/ask?p=2",
    "https://news.ycombinator.com/news?p=1",
  ]);
});

test("get_item requires a numeric id and builds the item URL", async () => {
  const root = await tempLearningsRoot();
  const ctx = stubCtx();

  await assert.rejects(
    runNodeSiteTool("hacker-news", "get_item", { id: "abc" }, ctx, { root }),
    /numeric item id is required/,
  );

  const item = await runNodeSiteTool(
    "hacker-news",
    "get_item",
    { id: "49056112" },
    ctx,
    { root },
  );

  assert.deepEqual(ctx.opened, [
    "https://news.ycombinator.com/item?id=49056112",
  ]);
  assert.equal(item.id, "49056112");
  assert.deepEqual(item.comments, []);
});

test("search_posts parses Algolia hits from the response body", async () => {
  const root = await tempLearningsRoot();
  const payload = JSON.stringify({
    hits: [
      {
        objectID: 42,
        title: "A story",
        url: "https://example.com",
        author: "pg",
        points: 100,
        num_comments: 7,
        created_at: "2026-07-26T00:00:00Z",
      },
      { objectID: 43, title: "Ask HN: no url", author: "dang" },
    ],
  });
  const ctx = stubCtx({ body: payload });

  await assert.rejects(
    runNodeSiteTool("hacker-news", "search_posts", {}, ctx, { root }),
    /search query is required/,
  );

  const results = await runNodeSiteTool(
    "hacker-news",
    "search_posts",
    { query: "browser automation", maxResults: 5 },
    ctx,
    { root },
  );

  assert.deepEqual(ctx.opened, [
    "https://hn.algolia.com/api/v1/search?query=browser%20automation&tags=story&hitsPerPage=5",
  ]);
  assert.deepEqual(results, [
    {
      id: "42",
      title: "A story",
      url: "https://example.com",
      author: "pg",
      points: 100,
      numComments: 7,
      createdAt: "2026-07-26T00:00:00Z",
    },
    {
      id: "43",
      title: "Ask HN: no url",
      url: "https://news.ycombinator.com/item?id=43",
      author: "dang",
      points: 0,
      numComments: 0,
      createdAt: "",
    },
  ]);
});
