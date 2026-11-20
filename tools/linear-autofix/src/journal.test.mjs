import assert from "node:assert/strict";
import { test } from "node:test";
import { isQuiet, renderTickLog } from "./journal.mjs";

const t0 = Date.parse("2026-11-02T04:00:00Z");
const base = {
  label: "tick",
  startedAt: t0,
  finishedAt: t0 + 95_000,
  costUsd: 3.2,
  issueCount: 35,
  host: "mac-mini",
};

test("a tick made only of waits posts nothing", () => {
  const events = [
    {
      identifier: "CITRO-1",
      event: "review check 28f5f732",
      detail: "ci=pending codex=none threads=0 -> wait",
    },
    {
      identifier: "CITRO-2",
      event: "waiting",
      detail: "2 PR(s) already in review (limit 2)",
    },
  ];
  assert.ok(events.every(isQuiet));
  assert.equal(renderTickLog({ ...base, events }), null);
});

test("an active tick lists events per ticket with header, duration and cost", () => {
  const events = [
    {
      identifier: "CITRO-1",
      event: "review check 28f5f732",
      detail: "ci=success codex=clean threads=0 -> done",
    },
    {
      identifier: "CITRO-1",
      event: "stage in_review -> done",
      detail: "Codex clean, CI green, no open threads",
    },
    { identifier: "CITRO-2", event: "waiting", detail: "limit" },
    {
      identifier: "CITRO-3",
      event: "triaged",
      detail: "needs_info (0.70) screenshot only",
    },
  ];
  const text = renderTickLog({ ...base, events });
  assert.match(text, /^\*\*tick\*\* · 2026-11-02 04:00 UTC · mac-mini/);
  assert.match(text, /35 ticket\(s\) scanned · 1m35s · Claude \$3\.20/);
  assert.match(
    text,
    /- \*\*CITRO-1\*\*\n {2}- review check 28f5f732: .*-> done\n {2}- stage in_review -> done/,
  );
  assert.match(text, /- \*\*CITRO-3\*\*\n {2}- triaged: needs_info/);
  assert.doesNotMatch(text, /CITRO-2/);
  assert.match(text, /1 wait event\(s\) omitted/);
});

test("a failed tick is logged even without events", () => {
  const text = renderTickLog({ ...base, events: [], error: "Linear HTTP 500" });
  assert.match(text, /Tick failed:.*Linear HTTP 500/);
});
