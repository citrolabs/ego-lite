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
   │  tick every 10 min
   ▼
new ──triage (claude, read-only)──► skipped  (browser_side / needs_info / ops_reply /
   │                                           design_decision / duplicate / already_fixed)
   └─ verdict fix ──► triaged
                        │ implement (claude in a worktree; failing test → fix → npm test → commit)
                        │ real-browser E2E on this machine, then git push (failed cases do not block)
                        │ gh pr create --base dev   (draft when the ticket needs Windows verification)
                        │ PR comment listing the failed E2E cases, if any
                        ▼
                     in_review ──► every tick: CI status + Codex comment for HEAD + unresolved threads
                        │             nothing left → done (Linear → Pending Review); human merges
                        │             findings → claude review-fix → commit → push → reply/resolve
                        ▼
                     escalated   (round limit, same findings twice, merge conflict, push failure,
                                  E2E suite did not finish, Claude says blocked, 3 consecutive errors)
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
  (`sudo pmset -a sleep 0 displaysleep 0`). The bot's E2E run drives ego lite
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
export AUTOFIX_E2E_KNOWN_FAILURES="Page keyboard interface"   # browser-side paste bug, see below
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
log comments on the log ticket), then keep it running. Two options.

**Option A, a `screen` session** (no launchd; the process paces itself):

```sh
screen -dmS linear-autofix /bin/zsh -lc 'source ~/.config/linear-autofix/env && cd ~/code/ego-lite/tools/linear-autofix && exec node src/cli.mjs daemon 2>&1 | tee -a /tmp/linear-autofix.log'
screen -r linear-autofix      # attach; Ctrl-A D detaches again
```

`daemon` runs a tick, sleeps `AUTOFIX_INTERVAL_MS` (default 10 min), repeats.
Ctrl-C or SIGTERM lets the current tick finish, then exits. The STOP file
skips ticks without killing the loop. A `screen` session does not survive a
reboot or a logout, so after either one start it again (or keep Option B).

**Option B, launchd** (survives reboots once the GUI session is back):

```sh
cp launchd/com.citrolabs.linear-autofix.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.citrolabs.linear-autofix.plist
launchctl kickstart -k gui/$(id -u)/com.citrolabs.linear-autofix   # run now
```

The agent runs `node src/cli.mjs tick` every 10 minutes from a login shell, so
fnm/nvm, `gh` and `claude` resolve as they do in a terminal. A pass still
running when the next one fires makes the newcomer exit (`tick.lock`). Local
logs go to `/tmp/linear-autofix.log`.

Operations:

```sh
node src/cli.mjs status
node src/cli.mjs stop        # STOP file: running tick finishes its step, later ticks exit
node src/cli.mjs resume
node src/cli.mjs publish CITRO-2908   # push failed or E2E did not finish? fix the host, then redo only E2E + push + PR
node src/cli.mjs retry CITRO-2908     # start over: re-triage and re-implement (keeps worktree and branch)
node src/cli.mjs reset CITRO-2908 --remote   # forget the ticket entirely: record, worktree, branches, bot labels
launchctl bootout gui/$(id -u)/com.citrolabs.linear-autofix   # uninstall the schedule
```

Pull requests are always based on `dev`: worktrees are cut from
`origin/dev`, diffs are measured against it, and `gh pr create --base dev`
is hard-coded. The branch the main checkout happens to be on does not matter,
with one rule: never check a ticket branch out in the main checkout. The bot
refuses to touch a ticket whose branch is checked out there, because a pull
or reset in that checkout would move the branch it is about to push.

Updating the bot: `git pull` on `dev`; the next tick picks up the new code.
State in `~/.local/state/linear-autofix` survives updates.

## Execution log on Linear

Every tick that did something (a triage, a PR, a review round, an escalation,
an error) posts one summary comment to the log ticket named by
`AUTOFIX_LOG_ISSUE` (default `CITRO-4786`): host, duration, Claude cost, and
one line per event. Ticks where every PR was merely waiting post nothing, so
the ticket stays readable. Set `AUTOFIX_LOG_ISSUE=` (empty) to disable.

## Configuration

| Variable                     | Default                                   | Meaning                                                  |
| ---------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `LINEAR_API_KEY`             | —                                         | required                                                 |
| `AUTOFIX_REPO`               | this checkout                             | repository the worktrees are created from                |
| `AUTOFIX_STATE_DIR`          | `~/.local/state/linear-autofix`           | records, runs, worktrees, lock, STOP                     |
| `AUTOFIX_LINEAR_STATES`      | `Backlog,Todo,In Progress,Pending Review` | states polled                                            |
| `AUTOFIX_BASE_BRANCH`        | `dev`                                     | PR base and worktree base                                |
| `AUTOFIX_MAX_IMPLEMENTING`   | `2`                                       | bot PRs allowed in review at once                        |
| `AUTOFIX_MAX_REVIEW_ROUNDS`  | `10`                                      | fix rounds per PR before escalating                      |
| `AUTOFIX_INTERVAL_MS`        | `600000` (10 min)                         | pause between ticks in `daemon` mode                     |
| `AUTOFIX_*_BUDGET_USD`       | triage 2 / implement 25 / review 15       | `--max-budget-usd` per Claude run                        |
| `AUTOFIX_*_TIMEOUT_MS`       | triage 10 min / implement 90 / review 60  | wall-clock limit per Claude run                          |
| `AUTOFIX_PUSH_TIMEOUT_MS`    | 45 min                                    | limit for the E2E suite, and for the push                |
| `AUTOFIX_CLAUDE_MODEL`       | Claude Code default                       | `--model`                                                |
| `AUTOFIX_E2E_KNOWN_FAILURES` | (empty)                                   | E2E cases the bot leaves out of its run and its comments |
| `AUTOFIX_LOG_ISSUE`          | `CITRO-4786`                              | Linear ticket that receives one comment per active tick  |
| `AUTOFIX_DRY_RUN`            | unset                                     | `1`: no Linear/GitHub writes, no push                    |
| `AUTOFIX_ISSUE`              | unset                                     | restrict a tick to one identifier                        |

## What counts as review feedback

- **Codex**: the review comment for the current head, parsed for findings.
- **Inline review comments** (Files changed → a line → comment, or a review
  with comments): every unresolved thread. The bot fixes or answers, replies in
  the thread, and resolves the threads it addressed. A thread it answered
  without resolving waits for a human.
- **PR conversation comments** from humans: every comment newer than the last
  one the bot handled. The bot treats each as a review request, acts on it
  within the ticket's scope, and answers in its round summary comment. There
  is no resolve state, so write a new comment to ask for more.
- **CI failures**: the failing check output.

The bot's own comments start with `<!-- linear-autofix -->` and are never fed
back to it. Feedback is picked up on the next tick (every 10 minutes by
default), so a comment is acted on within about ten minutes.

## Review-loop termination

A PR is finished when, for its current head commit, CI reported success, the
Codex review comment (tagged `<!-- codex-review -->` with the 8-char SHA) says
`No issues found that require changes.`, no review thread is unresolved, and
no human conversation comment is unanswered.
A thread the bot answered without resolving still counts as unresolved: it
blocks `done` and waits for a human, but does not trigger another fix round.
If CI or the Codex review has not reported for a head within two hours the
ticket escalates rather than finishing, since both run on every PR here.

Codex skips draft PRs, so a draft (Windows ticket) with green CI and no threads
is reported on Linear as _ready for Windows verification_ and waits for a human
to mark it ready; the loop then resumes.

Two rounds with the same Codex findings (compared after stripping SHAs,
timestamps and line numbers) mean the bot is not making progress and it
escalates instead of pushing again. A round whose outcome is `disputed`
produces a PR comment and no commit; the next tick sees the same findings and
escalates, which is intended: a dispute needs a human.

## E2E failures

Whenever the branch changes `package/ego-browser/` or `skills/ego-browser/`, the
bot runs the real-browser E2E suite on this host before every push, and pushes
with `LEFTHOOK_EXCLUDE=e2e-test` so the pre-push hook does not run it again.

A failed case does not stop the bot. It pushes, opens the PR as usual, and
comments on the PR with each failed case and its error. A later push whose run
passes says so in another comment. The bot does not try to fix these failures,
and they do not hold back `done`: E2E only runs on this host, so a human judges
them. The Linear comments for the PR warn about them while they apply to the
current head.

Some cases fail for reasons outside this repository (today: `Page keyboard
interface`, whose paste assertion hits a browser-side clipboard race). Name them
in `AUTOFIX_E2E_KNOWN_FAILURES` (comma-separated) to leave them out of the run
(`EGO_BROWSER_REAL_E2E_ONLY`), so they do not repeat in every PR's comment; the
PR body names the excluded cases. Remove a name as soon as the underlying bug
ships, so the case guards again.

## When a push fails

A failed push escalates the ticket, and so does an E2E run without a usable
result: it did not finish (build error, timeout) or no case passed (CLI missing,
browser down, unusable build). The escalation carries the last lines of the output;
the full output is in `runs/<ID>/<timestamp>-implement/push.log`. The commits
stay in `worktrees/<ID>`. To see the failure directly:

```sh
cd ~/.local/state/linear-autofix/worktrees/CITRO-2908
(cd package/ego-browser && npm run e2e)              # or: git push -u origin zhuoweiwang/citro-2908
```

Once the host is fixed (ego lite running and in the foreground, nobody
controlling it), `node src/cli.mjs publish CITRO-2908` redoes only E2E, the
push and the PR; the review loop takes over from there.

## Limitations

- Branch freshness: the bot merges `origin/dev` into its branch (merge commit)
  instead of rebasing, because it never force-pushes.
- Human comments made from the bot's own GitHub account look like human
  comments unless they carry the bot marker.
- Windows tickets are implemented but not verified; the PR stays a draft until
  someone verifies on the Windows VM.
