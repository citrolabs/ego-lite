# `ego-run`: persistent sessions for `ego-browser nodejs` (POC)

`ego-run` lets an agent keep one Node.js context alive across browser calls.
Today every `ego-browser nodejs` call starts a CLI process, opens a connection,
creates a Node context, installs the SDK, runs the script, and tears everything
down: about 100 ms of fixed cost per call, and no variables survive. With
`ego-run`, each agent-chosen **session** owns one `ego-browser nodejs` REPL
process that the daemon keeps open, and a call becomes one program sent to that
REPL: about 10 ms in the daemon, plus the thin CLI's own Node startup.

This is the first stage of the plan in the design document (zero browser
changes). It is started by hand during the POC; the browser does not start it.

## Layout

```text
package/ego-browser/src/daemon/
├── cli.ts                thin CLI (`ego-run`): parses arguments, talks to the daemon
├── client.ts             one-request-per-connection client, detached daemon start
├── server.ts             the daemon: lock, token, socket/pipe, dispatch, log, idle exit
├── session-manager.ts    session id → REPL connection; queueing, rebuild, eviction
├── repl-connection.ts    one `ego-browser nodejs` REPL under node-pty (raw mode)
├── program.ts            acorn rewrite + wrapper + result-line parsing
├── protocol.ts           request/response types, limits, error codes
└── paths.ts              state directory, socket path, token, lock, log
```

State lives in `~/.local/share/ego/daemon/` (macOS), `$XDG_STATE_HOME/ego/daemon/`
(Linux) or `%LOCALAPPDATA%\ego\daemon\` (Windows); `EGO_RUN_STATE_DIR`
overrides it. The thin CLI reaches the daemon over a Unix socket (named pipe on
Windows) and authenticates with the random token file next to it.

## Usage

```bash
ego-run daemon start --detach        # once per login; `ego-run daemon stop` ends it

ego-run --session order-flow <<'JS'
const task = await taskSpace("order-flow");
const page = task.page("p1");
await page.goto("https://example.com");
await page.snapshot()                // the last expression is the printed value
JS

ego-run --session order-flow -e 'await page.click("@3"); await page.snapshot()'
ego-run session list                 # live sessions, pids, evaluations, idle time
ego-run session close order-flow
```

The thin CLI never starts the daemon by itself: a daemon spawned from inside an
agent's sandboxed shell would inherit the sandbox. With `EGO_RUN_FALLBACK=1` it
runs the program once through `ego-browser nodejs` when the daemon is down and
says so on stderr.

`--sdk-path` is passed through to `ego-browser nodejs` and fixed for the
session's lifetime; `EGO_BROWSER_BIN` picks the executable the daemon starts.

## How a program runs

1. **Parse and rewrite** (`program.ts`). The program is parsed with acorn; a
   syntax error is reported with the user's line and column and never reaches
   the REPL. Top-level `const`/`let`/`var` become `var` declarations at REPL
   scope plus assignments, function declarations are copied to `globalThis`,
   classes become assignments, and the last expression statement becomes the
   `return` value. This keeps the REPL's own cross-cell persistence while the
   body runs inside an async wrapper.
2. **Wrap**. The body runs inside `await (async () => { ... })()` raced against
   the deadline. Using top-level `await` matters: the CLI's REPL loop only polls
   the runtime's captured output every 100 ms while waiting for stdin, but it
   returns the result of a cell as soon as the cell's evaluation completes, so
   awaiting the program delivers the result line immediately.
3. **Collect output**. The SDK buffers `console.*`, `cliLog`, `help()` and page
   notices in a sink that normally flushes at process exit. The SDK now exposes
   `globalThis.__egoBrowserFlushRound(stream, thrown)` so the wrapper can drain
   that sink after each program; with an older SDK it captures `console.*`
   directly. The result (`ok`, `value`, `logs`, `error`, `ms`) is written as one
   `@@EGO-RUN:<request id>:<json>` line with `process.stdout.write`. It is never
   left for the REPL to echo, because the echo goes through `util.inspect` and
   truncates strings at 10,000 characters. Results above 1 MB are written to
   `<state dir>/results/<request id>.json` and the path is returned instead.
4. **Send**. The cell goes through node-pty between `.cell` and `.end`. The pty
   is switched to raw mode (`stty raw -echo`) before `exec`, because in
   canonical mode the line discipline drops input lines longer than MAX_CANON
   (1024 bytes on macOS) and echo would mix the program into the output.

## Lifecycle rules

- Programs on one session run one at a time; different sessions run in
  parallel. At most 8 sessions; the least recently used idle one is evicted.
- A deadline (`--timeout-ms`, default 60 s, max 180 s) returns early to the
  agent, but the program keeps running in the context, so one deadline marks
  the session for rebuild and kills its REPL. The same happens when no result
  arrives at all (a program blocking the event loop) or when the REPL exits.
  The next call on that session starts a fresh context and `ego-run` prints
  `[ego-run] session "<id>" was rebuilt (<reason>)`.
- Sessions idle for 10 minutes are closed; the daemon exits after 30 minutes
  without sessions. `ego-browser --version` is checked every minute and a
  version change closes every session.
- `process.exit()` inside a program is refused (it would kill the runtime).
- The protocol carries a version; a mismatch tells the agent to restart the
  daemon after a plugin upgrade.

## Program boundaries (P3)

The SDK now treats one agent script as a *program* (`beginProgram()` /
`endProgram()` in `page-model.ts`, exposed as `__egoBeginProgram` /
`__egoEndProgram`). The direct CLI and `installEgoSdk` begin one per process;
the daemon wrapper calls both around every call. Inside a program:

- a Page is activated once, and again only when the script switches Pages;
- the file chooser safety interception is armed on the first guarded action
  and released at the end, instead of on and off around every action;
- the file-input probe is installed once per document (`documentEpoch()`), and
  reading it after an input action is the one renderer round trip that also
  orders popup events ahead of the receipt;
- frame discovery (`Target.getTargets` + `Page.getFrameTree`) is answered from a
  cache until a Target or Page frame lifecycle event invalidates it;
- the click point settle waits two frames only when something may be moving
  (a running animation or transition, or a scroll in the last 150 ms);
- `click({ hover: false })` skips the pre-press pointer move.

Measured on a local static form (CDP commands per action, direct path):
click 17 → 10, fill 15 → 12, press 15 → 8, snapshot 22 → 15, waitForSelector
6 → 3, evaluate 2 → 1. In a persistent session the second program pays one
`Target.activateTarget` and one `Page.setInterceptFileChooserDialog`, nothing
else. Click time 25 ms → 8 ms when the target is still, 2 to 5 ms with
`hover: false`.

## Guide variant

`skill-body/SKILL.md` carries `<!-- mode: direct -->` and `<!-- mode: ego-run -->`
blocks. The build renders the direct guide into `dist/out/ego-browser/` as
before (what the browser prints) and the ego-run guide into
`dist/out/ego-browser/ego-run/`. Nothing the browser ships changes until the
session mode is adopted.

## Known limits of the POC

- Needs Node ≥ 22 and node-pty (prebuilt for macOS and Windows; Linux builds
  from source and needs a compiler).
- Windows (ConPTY) has not been exercised yet.
- The 100 ms output poll in the CLI REPL loop is a browser-side constant; it is
  bypassed by the top-level-await trick, not removed.
- Browser-side follow-ups (runtime reuse keyed by `session_id`, `.abort`, a
  non-TTY `--repl` flag with JSON lines) would retire the daemon; see the design
  document.
