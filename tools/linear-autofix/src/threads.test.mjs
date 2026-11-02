import assert from "node:assert/strict";
import { test } from "node:test";
import { actionableThreads, renderThreads, splitThreads } from "./threads.mjs";

const thread = (
  id,
  { resolved = false, last = "please add a test", author = "reviewer" } = {},
) => ({
  id,
  isResolved: resolved,
  isOutdated: false,
  path: "package/ego-browser/src/run.ts",
  line: 4,
  comments: {
    nodes: [
      {
        author: { login: author },
        body: last,
        createdAt: "2026-10-30T00:00:00Z",
      },
    ],
  },
});

test("actionableThreads keeps unresolved threads the bot has not answered", () => {
  const threads = [
    thread("t1"),
    thread("t2", { resolved: true }),
    thread("t3", {
      last: "<!-- linear-autofix -->\nDone in abc123",
      author: "joway",
    }),
    { id: "t4", isResolved: false, comments: { nodes: [] } },
  ];
  assert.deepEqual(
    actionableThreads(threads).map((t) => t.id),
    ["t1"],
  );
});

test("splitThreads keeps bot-answered unresolved threads apart instead of dropping them", () => {
  const { fresh, awaitingHuman } = splitThreads([
    thread("t1"),
    thread("t2", { resolved: true }),
    thread("t3", {
      last: "<!-- linear-autofix -->\nDone in abc123",
      author: "joway",
    }),
  ]);
  assert.deepEqual(
    fresh.map((t) => t.id),
    ["t1"],
  );
  assert.deepEqual(
    awaitingHuman.map((t) => t.id),
    ["t3"],
  );
});

test("renderThreads includes the thread id, location and quoted comments", () => {
  const text = renderThreads([thread("PRRT_abc")]);
  assert.match(text, /Thread `PRRT_abc`/);
  assert.match(text, /run\.ts:4/);
  assert.match(text, /> \*\*reviewer\*\*: please add a test/);
});

test("splitThreads picks the newest comment by createdAt, whatever the array order", () => {
  const t = {
    id: "t9",
    isResolved: false,
    comments: {
      nodes: [
        {
          author: { login: "joway" },
          body: "<!-- linear-autofix -->\nfixed",
          createdAt: "2026-11-02T02:00:00Z",
        },
        {
          author: { login: "reviewer" },
          body: "still wrong",
          createdAt: "2026-11-02T01:00:00Z",
        },
      ],
    },
  };
  assert.deepEqual(
    splitThreads([t]).awaitingHuman.map((x) => x.id),
    ["t9"],
  );
  t.comments.nodes[1].createdAt = "2026-11-02T03:00:00Z";
  assert.deepEqual(
    splitThreads([t]).fresh.map((x) => x.id),
    ["t9"],
  );
});
