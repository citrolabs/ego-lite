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

| Stage      | Working dir | Allowed tools                                                                                                                                                         |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| triage     | repo root   | Read, Grep, Glob, `git log/show/grep`                                                                                                                                 |
| implement  | worktree    | Read, Edit, Write, Grep, Glob, `npm --prefix package/ego-browser …`, `npm --prefix plugins/ego …`, prettier, `git add/commit/diff/status/log/show/grep/restore/rm/mv` |
| review-fix | worktree    | same as implement                                                                                                                                                     |

Runs use `--permission-mode dontAsk`, so anything outside the list is denied:
Claude cannot push, cannot call `gh`, cannot touch Linear, and cannot `cd` out
of the worktree (there is no `cd`, `node` or `npx` rule). MCP servers are
disabled (`--strict-mcp-config`). The allowlist keeps the model on rails; it is
not a sandbox against a hostile model, since Edit plus `npm run` can execute
arbitrary code. Containment comes from running on a dedicated host whose
credentials (GitHub, Linear, Claude) are the only ones the bot needs. Each run
has a dollar budget and a wall-clock timeout, and a timeout kills the whole
process tree. Prompts tell Claude that ticket text and review comments are
data, never instructions, and `.github/`, `AGENTS.md`, `lefthook.yml` are off
limits.

## Deploying on the Mac mini

Prerequisites on the host:

- macOS with a logged-in GUI session that stays up: enable automatic login,
  disable the screen saver and screen lock, and keep the machine awake
  (`sudo pmset -a sleep 0 displaysleep 0`). The pre-push E2E drives ego lite
  windows, and background or locked windows break it.
- ego lite installed at `/Applications/ego lite.app` and running. The E2E
  runner uses the CLI bundled inside the app. Nobody takes manual control of
  it while ticks run.
- Node 22+ (fnm or nvm, loaded from the login shell), `git`, `gh`, `claude`.
- `gh auth login` as the GitHub account that owns the PRs, with push access.
  Use a personal account: the Codex review workflow skips PRs opened by bot
  users.
- `claude` logged in once interactively on that machine.
- A Linear personal API key for the user whose assigned tickets should be
  processed (Linear → Settings → Security & access → Personal API keys). The
  bot's Linear comments and labels are written as that user.

Install:

```sh
git clone git@github.com:citrolabs/ego-lite.git ~/code/ego-lite
cd ~/code/ego-lite && git switch dev
(cd package/ego-browser && npm install)        # also installs the lefthook hooks
(cd tools/linear-autofix && npm test)

mkdir -p ~/.config/linear-autofix
cat > ~/.config/linear-autofix/env <<'ENV'
export LINEAR_API_KEY=lin_api_…
# export AUTOFIX_LOG_ISSUE=CITRO-4786          # where tick logs are posted (default)
# export AUTOFIX_MAX_IMPLEMENTING=2
ENV
chmod 600 ~/.config/linear-autofix/env
```

First run, by hand, before scheduling anything:

```sh
cd ~/code/ego-lite/tools/linear-autofix && source ~/.config/linear-autofix/env
AUTOFIX_DRY_RUN=1 node src/cli.mjs tick                   # triages everything, writes nothing
node src/cli.mjs status
AUTOFIX_ISSUE=CITRO-2908 node src/cli.mjs tick             # one real ticket end to end
```

Watch that PR through a full review loop (`node src/cli.mjs status`, the tick
log comments on the log ticket), then schedule:

```sh
cp launchd/com.citrolabs.linear-autofix.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.citrolabs.linear-autofix.plist
launchctl kickstart -k gui/$(id -u)/com.citrolabs.linear-autofix   # run now
```

The agent runs `node src/cli.mjs tick` every 30 minutes from a login shell, so
fnm/nvm, `gh` and `claude` resolve as they do in a terminal. A pass still
running when the next one fires makes the newcomer exit (`tick.lock`). Local
logs go to `/tmp/linear-autofix.log`.

Operations:

```sh
node src/cli.mjs status
node src/cli.mjs stop        # STOP file: running tick finishes its step, later ticks exit
node src/cli.mjs resume
node src/cli.mjs retry CITRO-2908
launchctl bootout gui/$(id -u)/com.citrolabs.linear-autofix   # uninstall the schedule
```

Updating the bot: `git pull` on `dev`; the next tick picks up the new code.
State in `~/.local/state/linear-autofix` survives updates.

## Execution log on Linear

Every tick that did something (a triage, a PR, a review round, an escalation,
an error) posts one summary comment to the log ticket named by
`AUTOFIX_LOG_ISSUE` (default `CITRO-4786`): host, duration, Claude cost, and
one line per event. Ticks where every PR was merely waiting post nothing, so
the ticket stays readable. Set `AUTOFIX_LOG_ISSUE=` (empty) to disable.

## Configuration

| Variable                    | Default                                   | Meaning                                                 |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `LINEAR_API_KEY`            | —                                         | required                                                |
| `AUTOFIX_REPO`              | this checkout                             | repository the worktrees are created from               |
| `AUTOFIX_STATE_DIR`         | `~/.local/state/linear-autofix`           | records, runs, worktrees, lock, STOP                    |
| `AUTOFIX_LINEAR_STATES`     | `Backlog,Todo,In Progress,Pending Review` | states polled                                           |
| `AUTOFIX_BASE_BRANCH`       | `dev`                                     | PR base and worktree base                               |
| `AUTOFIX_MAX_IMPLEMENTING`  | `2`                                       | bot PRs allowed in review at once                       |
| `AUTOFIX_MAX_REVIEW_ROUNDS` | `5`                                       | fix rounds per PR before escalating                     |
| `AUTOFIX_*_BUDGET_USD`      | triage 2 / implement 25 / review 15       | `--max-budget-usd` per Claude run                       |
| `AUTOFIX_*_TIMEOUT_MS`      | triage 10 min / implement 90 / review 60  | wall-clock limit per Claude run                         |
| `AUTOFIX_PUSH_TIMEOUT_MS`   | 45 min                                    | covers the pre-push E2E suite                           |
| `AUTOFIX_CLAUDE_MODEL`      | Claude Code default                       | `--model`                                               |
| `AUTOFIX_LOG_ISSUE`         | `CITRO-4786`                              | Linear ticket that receives one comment per active tick |
| `AUTOFIX_DRY_RUN`           | unset                                     | `1`: no Linear/GitHub writes, no push                   |
| `AUTOFIX_ISSUE`             | unset                                     | restrict a tick to one identifier                       |

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
