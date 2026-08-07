# Task spaces — ownership, handoff, and completion policy

The full contract behind the summary in `SKILL.md`. Read this before any
claim / handoff / takeover / complete edge case.

## Naming and reuse

`nameOrId` can be a task space name, numeric id, or digit-only numeric id
string. String values match `name`/`taskId` first, then digit-only strings fall
back to numeric id. Number values match existing numeric ids only; if no
matching id exists, `taskSpaces.useOrCreate` fails instead of creating a new
space.

Use a short name for the active user goal when creating a new task space. Keep
reusing that task space for follow-up questions, corrections, refinements,
re-checks, and result validation, even if you previously thought the task was
complete. Choose a new task space only when the user clearly starts a separate,
unrelated goal. Prefer using the numeric `id` returned by
`taskSpaces.useOrCreate` (for example, `task.id`) to resume a known task in
later rounds and avoid name collisions.

For any follow-up on the same user goal — including continue, corrections,
retries, validation, user-reported problems, or work after
`taskSpaces.complete(..., { keep: true })` — resume the original task space
first if it still exists. Do not create a new task space for the same goal
unless the user asks for a fresh space, starts an unrelated goal, or the
original space is unavailable after checking. If a new space is necessary,
state why.

After explicit user confirmation, to continue work from an existing user-owned,
inactive, or unassigned task space, use `await taskSpaces.list()` to find the
space, call `await taskSpaces.claim(id)` to take ownership and select it, then
use `await browser.listTabs()` and `await browser.switchTab(targetId)` to
select the exact tab before acting.

## Ownership policy

Every task space has `ownership: 'agent' | 'agentDelegatedToUser' | 'user'`;
the facades treat user-owned spaces differently:

| Call | When the target space is user-owned |
|---|---|
| `taskSpaces.switch` | throws — agent-owned spaces only |
| `taskSpaces.claim` | claims it (ownership transfers to the agent), then selects it |
| `taskSpaces.handOff` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `taskSpaces.complete(…, { keep: true })` | skipped — resolves `{ done: false, skipped: 'user-owned' }` |
| `taskSpaces.complete(…, { keep: false })` | claims it, then closes it |
| `taskSpaces.takeOver` / `waitForAgentControl` | no ownership check |

`taskSpaces.handOff` and `taskSpaces.complete` resolve `{ done: true }` when
the operation actually happened. Check `done` before telling the user the
handoff/cleanup is finished — a `skipped` result usually means you targeted a
space that was never yours.

## Completion and cleanup

**`taskSpaces.complete(nameOrId, { keep })` must occupy its own dedicated final
heredoc, and run only after a prior heredoc's output has confirmed the task is
genuinely done.** `keep` is required and defaults by policy to `false`: close
the task space after completion unless there is a concrete reason to leave the
live page visible.

Use `{ keep: true }` only when the user explicitly asks to keep the page open,
the task needs manual user action in that exact page, or the result cannot be
delivered well as a URL, file, artifact, or summary. Do not keep a task space
open merely because a page was visited, a document was created, or a screenshot
was used for verification.

When passing a string that may create a new task space, the string should
reflect the task's intent (e.g. `'search github issues'`); don't use literal
placeholders.

**If the task space needs to be preserved after the task ends, keep only the
tabs that need to be shown to the user.** Keep loose awareness of how many tabs
are open — a quick `(await browser.listTabs()).length` is enough; there's no
need to spend a dedicated round just to check. When scratch tabs (search-result
pages, cross-check pages, and other one-off pages) pile up, close them as you
go rather than letting them all accumulate for the end. When finishing with
`{ keep: true }` to leave pages for the user, clear out the remaining scratch
tabs so only the pages worth showing stay open. Close a single tab with
`await browser.closeTab(targetId)` (`targetId` comes from `browser.listTabs()`
or an `openOrReuseTab` return value).

## Control handoff

Only one side — agent or user — holds control of a task space at any time.
While the user holds control, any browser operation by the agent fails with a
"user is controlling" message — do not retry it; follow the steps below to
resume.

A "user is controlling" error is a hard stop on the whole task — not an
obstacle to route around. It means the user has deliberately taken the browser
back, often because your current approach is going wrong. Honoring it *is* the
correct outcome here; pushing the goal forward anyway is the failure. The only
thing you may do is **ask the user and wait**.

An "inactive", "not assigned to an agent", or similar task-space error is also
a hard stop with the same confirmation requirement. Resume only after explicit
user confirmation, then start with `await taskSpaces.claim(id)`.

**Handing off**: When the task requires user intervention (e.g. login, captcha,
manual confirmation), call `await taskSpaces.handOff(nameOrId)` to give control
to the user, and tell them exactly what to do. Omitting `nameOrId` uses the
currently selected task space; pass `task.id` across heredoc rounds to avoid
ambiguity.

**Regaining control**: Take control back *only* after the user explicitly
confirms — through an Ask (your harness's button/option prompt, e.g. "Continue"
vs "Finish task") or a "continue" message in chat. Then start a new heredoc
with `await taskSpaces.takeOver(nameOrId)` and resume; if the user chooses to
finish, close out with `await taskSpaces.complete(nameOrId, { keep })`. Never
call `taskSpaces.takeOver` on your own to grab control back — it has no
ownership check and will seize the browser away from the user.

**Unexpected takeover**: The user can take over at any time via the browser GUI
— the same effect as the agent calling `taskSpaces.handOff`. Do not retry the
failed operation and do not auto-takeover; surface the Ask above (Continue /
Finish) and resume only when the user picks Continue.

`await taskSpaces.waitForAgentControl(nameOrId)` is a read-only blocking poll
(it never takes control); use it only to wait inside the current heredoc for a
handoff you initiated.
