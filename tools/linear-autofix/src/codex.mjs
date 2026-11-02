import { createHash } from "node:crypto";
import { config } from "./config.mjs";

/**
 * The Codex review workflow posts one standalone PR comment per push, tagged
 * with `<!-- codex-review -->` and a header carrying the 8-char head SHA.
 * Return the newest such comment for `headSha`, or null.
 */
export function findCodexReview(
  comments,
  headSha,
  marker = config.codexMarker,
) {
  const short = headSha.slice(0, 8);
  const matches = (comments ?? []).filter(
    (c) =>
      typeof c.body === "string" &&
      c.body.includes(marker) &&
      c.body.includes(`\`${short}\``),
  );
  if (!matches.length) return null;
  return matches
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .pop();
}

export function isCleanReview(body, cleanLine = config.codexCleanLine) {
  return extractFindings(body).trim() === cleanLine;
}

const FINDING_LINE = /^\s*-\s+\*\*\[(Blocker|Major|Minor|Nit)\]/m;

/**
 * 'clean' (the exact no-issues line), 'findings' (at least one severity
 * bullet), or 'inconclusive' (anything else: the reviewer failed to run, hit
 * a tooling problem, or produced free text). An inconclusive review is treated
 * like no review at all, so the loop waits for the next run instead of
 * "fixing" an apology.
 */
export function classifyReview(body, cleanLine = config.codexCleanLine) {
  const text = extractFindings(body);
  if (text.trim() === cleanLine) return "clean";
  if (FINDING_LINE.test(text)) return "findings";
  return "inconclusive";
}

/** The review body without the marker, title and timestamp lines. */
export function extractFindings(body) {
  return String(body ?? "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (t.startsWith("<!--")) return false;
      if (t.startsWith("## 🤖 Codex Review")) return false;
      if (t.startsWith("<sub>")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Fingerprint of the findings, stable across SHA and timestamp changes and
 * across line-number drift, so two rounds with the same complaints compare
 * equal. Used to detect a stalled review loop.
 */
export function findingsFingerprint(body) {
  const normalized = extractFindings(body)
    .toLowerCase()
    .replace(/:\d+(-\d+)?/g, ":N")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
