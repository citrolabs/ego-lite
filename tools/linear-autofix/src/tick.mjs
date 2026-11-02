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
} from "./state.mjs";
import { triage } from "./triage.mjs";
import { implement } from "./implement.mjs";
import { review } from "./review.mjs";
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
    record.commentCount > record.lastSeenCommentCount
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

async function guarded(record, fn) {
  try {
    await fn();
    clearErrors(record);
  } catch (err) {
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
    console.log(
      `${issues.length} assigned issue(s) in ${config.linearStates.join("/")}`,
    );

    const work = issues.map((issue) => ({
      issue,
      record: reconcile(upsertFromIssue(issue), issue),
    }));

    // 1. Review loops first: cheap checks that may finish a PR.
    for (const { issue, record } of work.filter(
      (w) => w.record.stage === "in_review",
    )) {
      if (stopRequested()) return;
      await guarded(record, () => review(issue, record));
    }

    // 2. Triage new tickets; adopt tickets whose branch already has an open PR.
    for (const { issue, record } of work.filter(
      (w) => w.record.stage === "new",
    )) {
      if (stopRequested()) return;
      await guarded(record, async () => {
        const existing = await github.findPr(record.branch);
        if (existing?.state === "OPEN") {
          record.pr = {
            number: existing.number,
            url: existing.url,
            draft: existing.isDraft,
          };
          record.review = { rounds: 0 };
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
      if (stopRequested()) return;
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
  }
}
