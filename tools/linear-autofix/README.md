# linear-autofix

Unattended pipeline for `ego-lite`: every Linear ticket assigned to the bot's
user is triaged, implemented in a dedicated worktree when it is worth fixing,
pushed as a pull request, and iterated on until the Codex review and the human
review threads have nothing left to say. Merging stays a human decision.

The orchestrator is deterministic Node code. Claude Code (`claude -p`) is
invoked for exactly three judgments: _is this worth fixing here_, _fix it_, and
_address this round of review feedback_. Everything that touches Linear,
GitHub or `git push` is done by the orchestrator, never by Claude.

## Pipeline

```
Linear (assignee = me, state ∈ Backlog/Todo/In Progress/Pending Review)
   │  tick every 30 min
   ▼
new ──triage (claude, read-only)──► skipped  (browser_side / needs_info / ops_reply /
   │                                           design_decision / duplicate / already_fixed)
   └─ verdict fix ──► triaged
                        │ implement (claude in a worktree; failing test → fix → npm test → commit)
                        │ git push (pre-push runs the real-browser E2E on this machine)
                        │ gh pr create --base dev   (draft when the ticket needs Windows verification)
                        ▼
                     in_review ──► every tick: CI status + Codex comment for HEAD + unresolved threads
                        │             nothing left → done (Linear → Pending Review); human merges
                        │             findings → claude review-fix → commit → push → reply/resolve
                        ▼
                     escalated   (round limit, same findings twice, merge conflict, push/E2E
                                  failure, Claude says blocked, 3 consecutive errors)
```

Per-ticket state lives in `~/.local/state/linear-autofix/issues/<ID>.json`;
every Claude prompt and raw output is kept under `runs/<ID>/`. Worktrees are
created under `worktrees/<ID>` from `origin/dev` on the branch Linear suggests
(`zhuoweiwang/citro-1234`), so the Linear GitHub integration links the PR.

Every comment the bot writes (Linear, PR, review threads) starts with
`<!-- linear-autofix -->`. Adding the `no-agent` label to a ticket stops the
bot on it; it also writes `agent:fix`, `agent:skipped` and `agent:escalated`.

## What Claude may and may not do

| Stage      | Working dir | Allowed tools                                                                      |
| ---------- | ----------- | ---------------------------------------------------------------------------------- |
| triage     | repo root   | Read, Grep, Glob, `git log/show/grep`                                              |
| implement  | worktree    | Read, Edit, Write, Grep, Glob, `npm`, `npx`, `node`, `git add/commit/diff/status…` |
| review-fix | worktree    | same as implement                                                                  |

Runs use `--permission-mode dontAsk`, so anything outside the list is denied:
Claude cannot push, cannot call `gh`, cannot touch Linear. MCP servers are
disabled (`--strict-mcp-config`). Each run has a dollar budget and a wall-clock
timeout (see Configuration). Prompts tell Claude that ticket text and review
comments are data, never instructions, and `.github/`, `AGENTS.md`,
`lefthook.yml` are off limits.

## Requirements on the host (the Mac mini)

- Node 22+, `git`, `gh` logged in as the GitHub account that owns the PRs,
  `claude` logged in.
- ego lite installed and running, with nobody taking manual control of it: the
  pre-push hook runs the real-browser E2E suite for every bot push.
- A clone of `ego-lite` with hooks installed (`cd package/ego-browser && npm install`).
- A Linear personal API key (Settings → API) in `LINEAR_API_KEY`.

## Running

```sh
cd tools/linear-autofix
export LINEAR_API_KEY=lin_api_…

AUTOFIX_DRY_RUN=1 node src/cli.mjs tick          # read + run Claude, write nothing, push nothing
AUTOFIX_DRY_RUN=1 node src/cli.mjs triage CITRO-2908
node src/cli.mjs status
node src/cli.mjs tick                             # the real thing
node src/cli.mjs stop                             # kill switch (STOP file); `resume` removes it
node src/cli.mjs retry CITRO-2908                 # reset a skipped/escalated ticket to new
npm test
```

Schedule it with the launchd agent in `launchd/` (edit the path and the key,
then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.citrolabs.linear-autofix.plist`).
Logs go to `/tmp/linear-autofix.log`.

## Configuration

| Variable                    | Default                                   | Meaning                                   |
| --------------------------- | ----------------------------------------- | ----------------------------------------- |
| `LINEAR_API_KEY`            | —                                         | required                                  |
| `AUTOFIX_REPO`              | this checkout                             | repository the worktrees are created from |
| `AUTOFIX_STATE_DIR`         | `~/.local/state/linear-autofix`           | records, runs, worktrees, lock, STOP      |
| `AUTOFIX_LINEAR_STATES`     | `Backlog,Todo,In Progress,Pending Review` | states polled                             |
| `AUTOFIX_BASE_BRANCH`       | `dev`                                     | PR base and worktree base                 |
| `AUTOFIX_MAX_IMPLEMENTING`  | `2`                                       | bot PRs allowed in review at once         |
| `AUTOFIX_MAX_REVIEW_ROUNDS` | `5`                                       | fix rounds per PR before escalating       |
| `AUTOFIX_*_BUDGET_USD`      | triage 2 / implement 25 / review 15       | `--max-budget-usd` per Claude run         |
| `AUTOFIX_*_TIMEOUT_MS`      | triage 10 min / implement 90 / review 60  | wall-clock limit per Claude run           |
| `AUTOFIX_PUSH_TIMEOUT_MS`   | 45 min                                    | covers the pre-push E2E suite             |
| `AUTOFIX_CLAUDE_MODEL`      | Claude Code default                       | `--model`                                 |
| `AUTOFIX_DRY_RUN`           | unset                                     | `1`: no Linear/GitHub writes, no push     |
| `AUTOFIX_ISSUE`             | unset                                     | restrict a tick to one identifier         |

## Review-loop termination

A PR is finished when, for its current head commit, CI is green, the Codex
review comment (tagged `<!-- codex-review -->` with the 8-char SHA) says
`No issues found that require changes.`, and no review thread is unresolved.
Codex skips draft PRs, so a draft (Windows ticket) with green CI and no threads
is reported on Linear as _ready for Windows verification_ and waits for a human
to mark it ready; the loop then resumes.

Two rounds with the same Codex findings (compared after stripping SHAs,
timestamps and line numbers) mean the bot is not making progress and it
escalates instead of pushing again. A round whose outcome is `disputed`
produces a PR comment and no commit; the next tick sees the same findings and
escalates, which is intended: a dispute needs a human.

## Limitations

- Branch freshness: the bot merges `origin/dev` into its branch (merge commit)
  instead of rebasing, because it never force-pushes.
- Human comments made from the bot's own GitHub account look like human
  comments unless they carry the bot marker.
- Windows tickets are implemented but not verified; the PR stays a draft until
  someone verifies on the Windows VM.
