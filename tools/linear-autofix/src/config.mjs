import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value))
    throw new Error(`${name} must be a number, got ${raw}`);
  return value;
}

function list(name, fallback) {
  const raw = process.env[name];
  return (raw ? raw.split(",") : fallback).map((s) => s.trim()).filter(Boolean);
}

export const config = Object.freeze({
  // The ego-lite checkout this tool lives in. Worktrees are created from it.
  repoRoot: process.env.AUTOFIX_REPO ?? path.resolve(here, "../../.."),
  stateDir:
    process.env.AUTOFIX_STATE_DIR ??
    path.join(os.homedir(), ".local/state/linear-autofix"),

  linearApiKey: process.env.LINEAR_API_KEY ?? "",
  linearStates: list("AUTOFIX_LINEAR_STATES", [
    "Backlog",
    "Todo",
    "In Progress",
    "Pending Review",
  ]),
  // Linear state names the bot moves issues to.
  linearStateInProgress:
    process.env.AUTOFIX_LINEAR_STATE_IN_PROGRESS ?? "In Progress",
  linearStatePendingReview:
    process.env.AUTOFIX_LINEAR_STATE_PENDING_REVIEW ?? "Pending Review",

  remote: process.env.AUTOFIX_REMOTE ?? "origin",
  baseBranch: process.env.AUTOFIX_BASE_BRANCH ?? "dev",
  packageDir: "package/ego-browser",

  maxImplementing: num("AUTOFIX_MAX_IMPLEMENTING", 2),
  maxReviewRounds: num("AUTOFIX_MAX_REVIEW_ROUNDS", 5),

  claudeBin: process.env.AUTOFIX_CLAUDE_BIN ?? "claude",
  claudeModel: process.env.AUTOFIX_CLAUDE_MODEL ?? "",
  triageBudgetUsd: num("AUTOFIX_TRIAGE_BUDGET_USD", 2),
  implementBudgetUsd: num("AUTOFIX_IMPLEMENT_BUDGET_USD", 25),
  reviewBudgetUsd: num("AUTOFIX_REVIEW_BUDGET_USD", 15),
  triageTimeoutMs: num("AUTOFIX_TRIAGE_TIMEOUT_MS", 10 * 60_000),
  implementTimeoutMs: num("AUTOFIX_IMPLEMENT_TIMEOUT_MS", 90 * 60_000),
  reviewTimeoutMs: num("AUTOFIX_REVIEW_TIMEOUT_MS", 60 * 60_000),
  // git push runs the pre-push real-browser E2E suite on this machine.
  pushTimeoutMs: num("AUTOFIX_PUSH_TIMEOUT_MS", 45 * 60_000),

  labels: Object.freeze({
    fix: "agent:fix",
    skipped: "agent:skipped",
    escalated: "agent:escalated",
    optOut: "no-agent",
  }),
  botMarker: "<!-- linear-autofix -->",
  codexMarker: "<!-- codex-review -->",
  codexCleanLine: "No issues found that require changes.",

  // AUTOFIX_DRY_RUN=1: read everything, run Claude, but never write to
  // Linear or GitHub and never push.
  dryRun: process.env.AUTOFIX_DRY_RUN === "1",
  // AUTOFIX_ISSUE=CITRO-1234 restricts a tick to one issue.
  onlyIssue: process.env.AUTOFIX_ISSUE ?? "",
});
