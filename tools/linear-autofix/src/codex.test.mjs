import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyReview,
  extractFindings,
  findCodexReview,
  findingsFingerprint,
  isCleanReview,
} from "./codex.mjs";

const clean = (sha) =>
  `<!-- codex-review -->\n\n## 🤖 Codex Review · \`${sha}\`\n\n<sub>2026-10-30 03:52 UTC · generated automatically by \`openai/codex-action\`</sub>\n\nNo issues found that require changes.`;
const findings = (sha, line) =>
  `<!-- codex-review -->\n\n## 🤖 Codex Review · \`${sha}\`\n\n<sub>2026-10-30 04:00 UTC</sub>\n\n- **[Major] package/ego-browser/src/run.ts:${line}** — the timeout is never cleared\n  Clear it in a finally block.`;

test("findCodexReview matches the head sha and prefers the newest", () => {
  const comments = [
    { body: clean("aaaaaaaa"), createdAt: "2026-10-30T03:00:00Z" },
    { body: findings("bbbbbbbb", 12), createdAt: "2026-10-30T04:00:00Z" },
    { body: clean("bbbbbbbb"), createdAt: "2026-10-30T05:00:00Z" },
    {
      body: "<!-- linear-autofix -->\nbot note",
      createdAt: "2026-10-30T06:00:00Z",
    },
  ];
  assert.equal(
    findCodexReview(comments, "bbbbbbbb1234567890").createdAt,
    "2026-10-30T05:00:00Z",
  );
  assert.equal(findCodexReview(comments, "cccccccc"), null);
  assert.equal(findCodexReview([], "aaaaaaaa"), null);
});

test("isCleanReview recognizes only the exact clean line", () => {
  assert.equal(isCleanReview(clean("abcd1234")), true);
  assert.equal(isCleanReview(findings("abcd1234", 1)), false);
  assert.equal(
    isCleanReview(`${clean("abcd1234")}\n\n- **[Nit] x.ts:1** — also this`),
    false,
  );
});

test("extractFindings drops marker, title and timestamp", () => {
  assert.equal(
    extractFindings(clean("abcd1234")),
    "No issues found that require changes.",
  );
  assert.match(extractFindings(findings("abcd1234", 7)), /^- \*\*\[Major\]/);
});

test("findingsFingerprint ignores sha, timestamp and line drift but not content", () => {
  assert.equal(
    findingsFingerprint(findings("aaaaaaaa", 12)),
    findingsFingerprint(findings("bbbbbbbb", 19)),
  );
  assert.notEqual(
    findingsFingerprint(findings("aaaaaaaa", 12)),
    findingsFingerprint(clean("aaaaaaaa")),
  );
  assert.notEqual(
    findingsFingerprint(findings("aaaaaaaa", 12)),
    findingsFingerprint(
      findings("aaaaaaaa", 12).replace("never cleared", "cleared twice"),
    ),
  );
});

test("classifyReview tells clean, findings and a reviewer that could not run apart", () => {
  assert.equal(classifyReview(clean("abcd1234")), "clean");
  assert.equal(classifyReview(findings("abcd1234", 3)), "findings");
  const failed = `<!-- codex-review -->\n\n## 🤖 Codex Review · \`abcd1234\`\n\n<sub>x</sub>\n\nI can't review the PR in this session because no shell tool is available.`;
  assert.equal(classifyReview(failed), "inconclusive");
});
