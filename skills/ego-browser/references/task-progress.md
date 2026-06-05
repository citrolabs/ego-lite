# Track progress for long tasks

Read this file when you decide a browser task is long or complex enough to track (see SKILL.md → "Long multi-round tasks"). For short, 1–2 round tasks, skip it — the overhead isn't worth it.

## Why

A long task runs across many heredoc rounds. Over that span it's easy to lose the thread — which pages you've already settled, what each one told you, what's still on the plan — and end up repeating work or drifting off the original goal. An external ledger you keep current fixes that: it records the goal, the plan, per-page conclusions, and the next concrete step, and you consult it to stay oriented and to resume cleanly. Treat the file as the source of truth for where the task stands.

## The one rule that makes this work

> Store **conclusions and state**, never **raw observations**. Keep it bounded. Consulting it must stay cheap.

Never paste `snapshotText`, screenshots, HTML, or full logs into the file. Its whole value is that it's small enough to re-read in a glance; dumping raw observations into it defeats that. Each page becomes one line: a URL and a one-sentence conclusion. Keep the whole file to a few screens; when older rows stop mattering, compress them.

## Where it lives and who writes it

- Path: `.ego-browser/task-progress.md`, in your current working directory. One file per active task; the task identity lives in the header, not in the path.
- **You** maintain it with `Read` / `Write` / `Edit`. The `ego-browser nodejs` heredoc is a fresh, stateless process every round — it never reads or writes this file. The heredoc produces observations via `cliLog`; you distill those into the file.
- If the working directory is a git repo, add `.ego-browser/` to `.gitignore` once so this scratch state isn't accidentally committed.

## When to create it

Create it at the **start** of the task when any of these hold:

- the task likely needs more than ~3 heredoc rounds, or spans more than ~2 pages/sites;
- it's open-ended exploration where the page set isn't known upfront;
- it needs a control handoff (login / captcha), so you may resume after a gap;
- the request has multiple deliverables or a multi-step flow (multi-page form, checkout, cross-page aggregation).

If you didn't create one and the task is dragging — you're past ~3 rounds, or you're losing track of what you've already done — create it now from your current memory. Retroactive is fine; missing is not.

## File format

```markdown
# Task Progress — <short task name>

<!-- Conclusions and state only. Never raw snapshotText / screenshots / HTML.
     Re-read this when resuming and unsure of the current state. -->

- **space name:** <the name you passed to useOrCreateTaskSpace>
- **updated:** round <N>
- **status:** in-progress | blocked | done

## Goal
<1–3 sentences. The success criterion. Set once; rarely changes.>

## Plan
- [x] Step that's done
- [ ] Current step  ← you are here
- [ ] Next step

## Next action
<One concrete action to take on resume: target URL / @ref / operation.
 This is the single most important anchor — keep it current.>

## Pages visited (conclusions only)
| # | URL / page | Conclusion (no raw content) |
|---|------------|-----------------------------|
| 1 | https://…  | Found X; login valid; pagination is ?page= |
| 2 | https://…  | Dead end — missing Y |

## Findings
<Confirmed material for the final deliverable, accumulated across rounds.>

## Blockers / open questions
- Handed off for captcha — waiting on user
- Unverified: does the API paginate?

## Dead ends (avoid repeating)
- Tried Z → failed because …
```

Drop sections you don't need (e.g. no blockers yet), but always keep **Goal**, **Plan**, and **Next action** — those three are what resuming depends on.

## When to update

At the end of every heredoc round that changed the task state, **edit** the file (don't append a running log):

- distill the round's `cliLog` output into one-line conclusions in **Pages visited**;
- tick / move the `← you are here` marker in **Plan**;
- rewrite **Next action** to the next single concrete step;
- add to **Findings** / **Dead ends** as they accrue;
- bump `updated: round N` and `status`.

Keep edits surgical and the file bounded. If **Pages visited** grows long, collapse exhausted detours into a single summary row.

## Resuming the task

Re-read the file first — before any heredoc — whenever you're picking the task back up and aren't fully certain of the current state (for example, after a handoff). Then:

1. Re-bind to the task space: `useOrCreateTaskSpace(<space name from the header>)`. This reattaches to the same in-browser space; it persists in the browser process across rounds.
2. Take **Next action**. Don't re-explore pages already settled in **Pages visited**, and don't retry anything under **Dead ends**.
3. Continue updating the file as you go.

## Finishing

When the task is done, set `status: done` and let the file fall away with the working directory — it's scratch state, not a deliverable. The deliverable goes to the user through your normal reply (and the page itself via `completeTaskSpace(name, { keep })`).
