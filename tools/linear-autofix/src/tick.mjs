import { UsageLimitError } from "./claude.mjs";
import { config } from "./config.mjs";
import * as github from "./github.mjs";
import * as linear from "./linear.mjs";
import {
  acquireLock,
  loadAll,
  note,
  releaseLock,
  stopRequested,
  transition,
  upsertFromIssue,
  usagePausedUntil,
} from "./state.mjs";
import { triage } from "./triage.mjs";
import { implement } from "./implement.mjs";
import { review, watchDone } from "./review.mjs";
import { clearErrors, recordError } from "./actions.mjs";
import { flushTickLog } from "./journal.mjs";

/** Linear priority: 0 = none, 1 = urgent … 4 = low. Sort none last. */
export function byPriority(a, b) {
  const pa = a.priority || 5;
  const pb = b.priority || 5;
  return pa - pb || String(a.createdAt).localeCompare(String(b.createdAt));
}

/** Apply the record-level rules that do not need Claude or network. Pure apart from persistence. */
export function reconcile(record, issue) {
  const optedOut = (issue.labels?.nodes ?? []).some(
    (l) => l.name === config.labels.optOut,
  );
  if (optedOut && !["done", "skipped", "escalated"].includes(record.stage)) {
    transition(record, "skipped", "opt-out label present");
    return record;
  }
  if (optedOut) return record;
  if (
    record.stage === "skipped" &&
    record.triage?.verdict === "needs_info" &&
    (record.latestCommentAt ?? "") > (record.lastSeenCommentAt ?? "")
  ) {
    transition(
      record,
      "new",
      "new comment on a needs_info ticket, re-triaging",
    );
  }
  if (record.stage === "implementing") {
    transition(
      record,
      "triaged",
      "previous implementation run did not finish, retrying",
    );
  }
  return record;
}

/** "in_review 2, new 1" for the log. Pure. */
export function stageCounts(records) {
  const counts = new Map();
  for (const r of records) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
  return [...counts].map(([stage, n]) => `${stage} ${n}`).join(", ") || "none";
}

/** Prefix console output with the local time, so a quiet stretch is visible as one. */
export function timestampLogs() {
  for (const method of ["log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) =>
      original(new Date().toLocaleString("sv"), ...args);
  }
}

async function guarded(record, fn) {
  try {
    await fn();
    clearErrors(record);
  } catch (err) {
    // Not the ticket's fault: it does not count toward escalation, and it
    // resumes from its current stage once the pause ends.
    if (err instanceof UsageLimitError) {
      note(record, "usage limit", err.message);
      return;
    }
    await recordError(record, err);
  }
}

export async function tick() {
  if (!acquireLock()) {
    console.log("another tick is running; exiting");
    return;
  }
  const startedAt = Date.now();
  let issueCount;
  let failure;
  try {
    if (stopRequested()) {
      console.log(`STOP file present in ${config.stateDir}; exiting`);
      return;
    }
    if (config.dryRun)
      console.log("[dry-run] no writes to Linear or GitHub, no push");

    let issues = await linear.fetchAssignedIssues();
    if (config.onlyIssue)
      issues = issues.filter((i) => i.identifier === config.onlyIssue);
    issues.sort(byPriority);
    issueCount = issues.length;
    console.log(
      `${issues.length} assigned issue(s) in ${config.linearStates.join("/")}`,
    );

    const work = issues.map((issue) => ({
      issue,
      record: reconcile(upsertFromIssue(issue), issue),
    }));
    console.log(`stages: ${stageCounts(work.map((w) => w.record))}`);

    // 0. Finished PRs that are still open: a human comment reopens the loop.
    for (const { record } of work.filter((w) => w.record.stage === "done")) {
      if (stopRequested()) return;
      await guarded(record, () => watchDone(record));
    }

    // 1. Review loops first: cheap checks that may finish a PR.
    for (const { issue, record } of work.filter(
      (w) => w.record.stage === "in_review",
    )) {
      if (stopRequested()) return;
      await guarded(record, () => review(issue, record));
    }

    const pausedUntil = usagePausedUntil();
    if (pausedUntil) {
      console.log(
        `Claude usage paused until ${new Date(pausedUntil).toISOString()}; skipping triage and implementation`,
      );
      return;
    }

    // 2. Triage new tickets; adopt tickets whose branch already has an open PR.
    for (const { issue, record } of work.filter(
      (w) => w.record.stage === "new",
    )) {
      if (stopRequested() || usagePausedUntil()) return;
      await guarded(record, async () => {
        const existing = await github.findPr(record.branch);
        if (existing?.state === "OPEN") {
          record.pr = {
            number: existing.number,
            url: existing.url,
            draft: existing.isDraft,
          };
          // Adopted PRs may already carry human comments: see them all.
          record.review = { rounds: 0, commentsSeenAt: "" };
          transition(
            record,
            "in_review",
            `adopted existing PR ${existing.url}`,
          );
          return;
        }
        await triage(issue, record);
      });
    }

    // 3. Implement, bounded by the number of bot PRs already in review.
    const open = () => loadAll().filter((r) => r.stage === "in_review").length;
    for (const { issue, record } of work.filter(
      (w) => w.record.stage === "triaged",
    )) {
      if (stopRequested() || usagePausedUntil()) return;
      if (open() >= config.maxImplementing) {
        note(
          record,
          "waiting",
          `${open()} PR(s) already in review (limit ${config.maxImplementing})`,
        );
        continue;
      }
      await guarded(record, () => implement(issue, record));
    }
  } catch (err) {
    failure = err?.message ?? String(err);
    throw err;
  } finally {
    await flushTickLog({
      label: "tick",
      startedAt,
      issueCount,
      error: failure,
    });
    releaseLock();
    console.log(
      `tick finished in ${Math.round((Date.now() - startedAt) / 1000)} s`,
    );
  }
}

/**
 * Run ticks forever with `config.intervalMs` between them. For hosts without
 * launchd: `screen -dmS linear-autofix … node src/cli.mjs daemon`. SIGINT and
 * SIGTERM finish the current tick, then exit. The STOP file skips ticks but
 * keeps the loop alive, so `resume` takes effect without a restart.
 */
export async function daemon() {
  let stopping = false;
  const onSignal = (signal) => {
    console.log(`${signal} received; finishing the current tick, then exiting`);
    stopping = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  console.log(
    `daemon: tick every ${Math.round(config.intervalMs / 60_000)} min, state in ${config.stateDir}`,
  );
  while (!stopping) {
    const started = Date.now();
    try {
      await tick();
    } catch (err) {
      console.error(`tick failed: ${err?.stack ?? err}`);
    }
    const wait = Math.max(60_000, config.intervalMs - (Date.now() - started));
    console.log(`next tick at ${new Date(Date.now() + wait).toISOString()}`);
    for (let waited = 0; waited < wait && !stopping; waited += 1000) {
      await new Promise((r) => setTimeout(r, Math.min(1000, wait - waited)));
    }
  }
}
