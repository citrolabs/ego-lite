import os from "node:os";
import { config } from "./config.mjs";
import { claudeCostUsd } from "./claude.mjs";
import * as linear from "./linear.mjs";
import { clearJournal, journalEvents, truncate } from "./state.mjs";

/** Events that only say "nothing to do yet"; a tick made of these posts no log. */
export function isQuiet(event) {
  return (
    event.event === "waiting" ||
    (event.event.startsWith("review check") && /-> wait$/.test(event.detail))
  );
}

/**
 * Render one tick's events as a Linear comment. Pure. Returns null when the
 * tick was quiet (every event was a wait) and there were no errors.
 */
export function renderTickLog({
  label,
  events,
  startedAt,
  finishedAt,
  costUsd,
  issueCount,
  error,
  host = os.hostname(),
}) {
  const active = events.filter((e) => !isQuiet(e));
  if (!active.length && !error) return null;
  const seconds = Math.round((finishedAt - startedAt) / 1000);
  const duration =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
      : `${seconds}s`;
  const head = [
    `**${label}** · ${new Date(startedAt).toISOString().replace("T", " ").slice(0, 16)} UTC · ${host}`,
    `${issueCount ?? "?"} ticket(s) scanned · ${duration} · Claude $${costUsd.toFixed(2)}${config.dryRun ? " · dry-run" : ""}`,
  ];
  const byIssue = new Map();
  for (const e of active) {
    if (!byIssue.has(e.identifier)) byIssue.set(e.identifier, []);
    byIssue.get(e.identifier).push(e);
  }
  const body = [];
  for (const [identifier, list] of byIssue) {
    body.push(`- **${identifier}**`);
    for (const e of list)
      body.push(
        `  - ${e.event}${e.detail ? `: ${truncate(e.detail, 300)}` : ""}`,
      );
  }
  if (error) body.push(``, `**Tick failed:** \`${truncate(error, 500)}\``);
  const quiet = events.length - active.length;
  if (quiet) body.push(``, `_${quiet} wait event(s) omitted._`);
  return [...head, ``, ...body].join("\n");
}

/** Post the journal of this process to the log ticket, then clear it. Never throws. */
export async function flushTickLog({ label, startedAt, issueCount, error }) {
  const events = journalEvents();
  clearJournal();
  if (!config.logIssue) return;
  const text = renderTickLog({
    label,
    events,
    startedAt,
    finishedAt: Date.now(),
    costUsd: claudeCostUsd(),
    issueCount,
    error,
  });
  if (!text) return;
  try {
    const issue = await linear.fetchIssue(config.logIssue);
    if (!issue) throw new Error(`log issue ${config.logIssue} not found`);
    await linear.comment(
      { id: issue.id, identifier: issue.identifier, teamId: issue.team?.id },
      text,
    );
  } catch (err) {
    console.error(
      `could not post the tick log to ${config.logIssue}: ${err.message}`,
    );
  }
}
