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

const packagedGithubDir = fileURLToPath(
  new URL("../../../../skills/ego-browser/learnings/github", import.meta.url),
);

// Copy the packaged learning into a temp workspace so the suite runs
// independently of any package.json module scope above the repository.
async function tempLearningsRoot() {
  const root = await mkdtemp(join(tmpdir(), "ego-github-learning-"));
  await cp(packagedGithubDir, join(root, "github"), { recursive: true });
  return root;
}

function stubCtx(attributes = {}) {
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
      waitForSelector: async () => {},
      locator: (selector) => ({
        evaluateAll: async () => [],
        getAttribute: async (name) => attributes[`${selector} ${name}`] ?? null,
      }),
    },
  };
}

test("github learning pack passes format validation", async () => {
  const root = await tempLearningsRoot();
  assert.deepEqual(await validateLearning(join(root, "github")), []);
});

test("loadLearnedContext surfaces github tools for repository URLs", async () => {
  const root = await tempLearningsRoot();
  const context = await loadLearnedContext(
    "https://github.com/citrolabs/ego-lite",
    { root },
  );

  assert.equal(context.exists, true);
  assert.equal(context.siteId, "github");
  const toolNames = context.tools.map((tool) => tool.toolName);
  assert.deepEqual(toolNames.sort(), [
    "extract_readme",
    "get_repo_info",
    "get_trending_repos",
    "search_repositories",
  ]);
});

test("search_repositories requires a query and encodes the search URL", async () => {
  const root = await tempLearningsRoot();
  const ctx = stubCtx();

  await assert.rejects(
    runNodeSiteTool("github", "search_repositories", {}, ctx, { root }),
    /search query is required/,
  );

  const results = await runNodeSiteTool(
    "github",
    "search_repositories",
    { query: "browser automation" },
    ctx,
    { root },
  );

  assert.deepEqual(results, []);
  assert.deepEqual(ctx.opened, [
    "https://github.com/search?q=browser%20automation&type=repositories",
  ]);
});

test("get_repo_info parses exact counts from counter title attributes", async () => {
  const root = await tempLearningsRoot();
  const ctx = stubCtx({
    "#repo-stars-counter-star title": "4,126",
    "#repo-network-counter title": "312",
    'meta[property="og:description"] content': " A shared browser. ",
  });

  const info = await runNodeSiteTool(
    "github",
    "get_repo_info",
    { owner: "citrolabs", repo: "ego-lite" },
    ctx,
    { root },
  );

  assert.deepEqual(info, {
    name: "citrolabs/ego-lite",
    url: "https://github.com/citrolabs/ego-lite",
    description: "A shared browser.",
    stars: 4126,
    forks: 312,
  });

  await assert.rejects(
    runNodeSiteTool("github", "get_repo_info", { owner: "citrolabs" }, ctx, {
      root,
    }),
    /owner and repo are required/,
  );
});

test("get_trending_repos builds the language and window URL", async () => {
  const root = await tempLearningsRoot();
  const ctx = stubCtx();

  await runNodeSiteTool(
    "github",
    "get_trending_repos",
    { language: "TypeScript", since: "weekly" },
    ctx,
    { root },
  );
  await runNodeSiteTool(
    "github",
    "get_trending_repos",
    { since: "hourly" },
    ctx,
    {
      root,
    },
  );

  assert.deepEqual(ctx.opened, [
    "https://github.com/trending/typescript?since=weekly",
    "https://github.com/trending?since=daily",
  ]);
});
