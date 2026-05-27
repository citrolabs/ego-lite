import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadLearnedContext } from "../dist/src/learning/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEARNINGS_ROOT = join(__dirname, "..", "..", "..", "skills", "ego-browser", "learnings");
const LEARNING_PACK_ROOT = join(__dirname, "..", "..", "..", "skills", "ego-browser", "learnings");

async function withTempLearningRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "ego-browser-learn-context-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function importLearningPackModule(relativePath) {
  return import(pathToFileURL(join(LEARNING_PACK_ROOT, relativePath)).href);
}

test("learnContext matches x.com and returns tools with knowledge", async () => {
  const ctx = await loadLearnedContext("https://x.com/home", { root: LEARNINGS_ROOT });
  assert.ok(ctx.exists);
  assert.equal(ctx.siteId, "x-com");
  assert.equal(ctx.siteName, "X (Twitter)");
  assert.ok(ctx.knowledge.length > 0);
  assert.ok(ctx.tools.some((t) => t.toolName === "get_timeline_posts"));
  assert.ok(ctx.tools.some((t) => t.toolType === "browser"));
});

test("learnContext matches google.com and returns search tools", async () => {
  const ctx = await loadLearnedContext("https://www.google.com/search?q=test", { root: LEARNINGS_ROOT });
  assert.ok(ctx.exists);
  assert.equal(ctx.siteId, "google");
  assert.ok(ctx.tools.some((t) => t.toolName === "search_and_extract"));
  assert.ok(ctx.tools.some((t) => t.toolName === "get_autocomplete_suggestions"));
});

test("learnContext matches github.com and returns repo tools", async () => {
  const ctx = await loadLearnedContext("https://github.com/org/repo", { root: LEARNINGS_ROOT });
  assert.ok(ctx.exists);
  assert.equal(ctx.siteId, "github");
  assert.ok(ctx.tools.some((t) => t.toolName === "search_repos"));
  assert.ok(ctx.tools.some((t) => t.toolName === "get_open_issues"));
});

test("learnContext returns empty context for unknown domain", async () => {
  const ctx = await loadLearnedContext("https://unknown-random-site.org", { root: LEARNINGS_ROOT });
  assert.ok(!ctx.exists);
  assert.equal(ctx.siteId, null);
  assert.deepEqual(ctx.tools, []);
  assert.deepEqual(ctx.knowledge, []);
});

test("learnContext does not read traversal note paths", async () => {
  await withTempLearningRoot(async (root) => {
    const site = join(root, "example");
    await mkdir(site, { recursive: true });
    await writeFile(join(root, "secret.md"), "secret\n");
    await writeFile(join(site, "manifest.json"), JSON.stringify({
      id: "example",
      name: "Example",
      domains: ["example.com"],
      notes: ["../../secret.md"],
      nodeTools: {},
      browserTools: {}
    }));

    const ctx = await loadLearnedContext("https://example.com", { root });

    assert.equal(ctx.exists, true);
    assert.deepEqual(ctx.knowledge, []);
  });
});

test("learning node tools sanitize numeric limits before page evaluation", async () => {
  const calls = [];
  const ctx = {
    openOrReuseTab: async () => {},
    waitForLoad: async () => {},
    js: async (expression) => {
      calls.push(expression);
      return [];
    }
  };
  const injected = "1);globalThis.pwned=1;//";

  const { searchRepos } = await importLearningPackModule("github/tools/search-repos.js");
  await searchRepos(ctx, { query: "agent", maxResults: injected });
  const { searchAndExtract } = await importLearningPackModule("google/tools/search-extract.js");
  await searchAndExtract(ctx, { query: "agent", maxResults: injected });
  const { getTimelinePosts } = await importLearningPackModule("x-com/tools/timeline.js");
  await getTimelinePosts(ctx, { maxPosts: injected });

  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("slice(0, 25)"));
  assert.ok(calls[1].includes("slice(0, 10)"));
  assert.ok(calls[2].includes("slice(0, 50)"));
  assert.ok(calls.every((expression) => !expression.includes("globalThis.pwned")));
});

test("GitHub issue tool rejects unsafe owner and repo path segments", async () => {
  const { getOpenIssues } = await importLearningPackModule("github/tools/open-issues.js");
  const ctx = {
    openOrReuseTab: async () => {
      throw new Error("navigation should not run");
    },
    waitForLoad: async () => {},
    js: async () => []
  };

  await assert.rejects(
    () => getOpenIssues(ctx, { owner: "org/path", repo: "repo" }),
    /valid GitHub owner and repo are required/
  );
  await assert.rejects(
    () => getOpenIssues(ctx, { owner: "org", repo: "repo/issues?q=x" }),
    /valid GitHub owner and repo are required/
  );
});
