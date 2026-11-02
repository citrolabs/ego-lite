#!/usr/bin/env node
import { config } from "./config.mjs";
import * as linear from "./linear.mjs";
import {
  load,
  loadAll,
  setStop,
  stopRequested,
  transition,
  upsertFromIssue,
} from "./state.mjs";
import { daemon, reconcile, tick } from "./tick.mjs";
import { triage } from "./triage.mjs";
import { implement, publish } from "./implement.mjs";
import { review } from "./review.mjs";
import { flushTickLog } from "./journal.mjs";

const USAGE = `linear-autofix — Linear ticket → PR → review loop, unattended

Usage:
  linear-autofix tick                 one scheduler pass over all assigned tickets
  linear-autofix daemon               run ticks forever, AUTOFIX_INTERVAL_MS apart (for screen/tmux)
  linear-autofix triage <CITRO-123>   triage one ticket now
  linear-autofix implement <ID>       implement a ticket that was triaged as fix
  linear-autofix review <ID>          run one review-loop check for a ticket's PR
  linear-autofix publish <ID>         push the worktree and open the PR again (after a failed push)
  linear-autofix retry <ID>           reset a skipped/escalated ticket to "new" (re-triage, re-implement)
  linear-autofix status               list tracked tickets and their stage
  linear-autofix stop | resume        create / remove the STOP file (kill switch)

Environment: LINEAR_API_KEY (required), AUTOFIX_DRY_RUN=1, AUTOFIX_ISSUE=<ID>, AUTOFIX_LOG_ISSUE,
AUTOFIX_STATE_DIR, AUTOFIX_MAX_IMPLEMENTING, AUTOFIX_MAX_REVIEW_ROUNDS, … see README.
`;

/** Run a single-ticket stage and post its events to the log ticket. */
async function logged(label, fn) {
  const startedAt = Date.now();
  try {
    await fn();
  } catch (err) {
    await flushTickLog({
      label,
      startedAt,
      issueCount: 1,
      error: err?.message ?? String(err),
    });
    throw err;
  }
  await flushTickLog({ label, startedAt, issueCount: 1 });
}

async function one(identifier) {
  if (!identifier) throw new Error("issue identifier required");
  const issue = await linear.fetchIssue(identifier);
  if (!issue) throw new Error(`Linear has no issue ${identifier}`);
  return { issue, record: reconcile(upsertFromIssue(issue), issue) };
}

function status() {
  const records = loadAll().sort(
    (a, b) =>
      a.stage.localeCompare(b.stage) ||
      a.identifier.localeCompare(b.identifier),
  );
  if (stopRequested())
    console.log("STOP file present: ticks exit immediately\n");
  const width = Math.max(10, ...records.map((r) => r.identifier.length));
  for (const r of records) {
    const extra = r.pr?.url ?? r.triage?.verdict ?? "";
    console.log(
      `${r.stage.padEnd(12)} ${r.identifier.padEnd(width)} ${extra.padEnd(60)} ${r.title ?? ""}`,
    );
  }
  console.log(`\n${records.length} tracked · state dir ${config.stateDir}`);
}

async function main([command, arg]) {
  switch (command) {
    case "tick":
      return tick();
    case "daemon":
      return daemon();
    case "triage": {
      const { issue, record } = await one(arg);
      return triage(issue, record);
    }
    case "implement": {
      const { issue, record } = await one(arg);
      if (record.stage !== "triaged")
        throw new Error(`${arg} is in stage ${record.stage}, expected triaged`);
      return implement(issue, record);
    }
    case "review": {
      const { issue, record } = await one(arg);
      if (record.stage !== "in_review")
        throw new Error(
          `${arg} is in stage ${record.stage}, expected in_review`,
        );
      return review(issue, record);
    }
    case "publish": {
      const { record } = await one(arg);
      if (!["escalated", "triaged", "implementing"].includes(record.stage))
        throw new Error(
          `${arg} is in stage ${record.stage}; publish is for a ticket whose push or PR failed`,
        );
      return logged(`publish ${arg}`, () => publish(record));
    }
    case "retry": {
      const record = load(arg);
      if (!record) throw new Error(`no record for ${arg}`);
      record.consecutiveErrors = 0;
      transition(record, "new", "manual retry");
      return;
    }
    case "status":
      return status();
    case "stop":
      setStop(true);
      return console.log(
        "STOP file created; running tick finishes its current step and later ticks exit",
      );
    case "resume":
      setStop(false);
      return console.log("STOP file removed");
    default:
      process.stdout.write(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
