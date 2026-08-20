# ego-windows-host

Run the `ego-browser` agent runtime against stock Microsoft Edge or Google
Chrome on Windows — a preview for Windows users while native ego lite Windows
support (#203) is under evaluation.

The [ego lite app](https://lite.ego.app/) is macOS-only today. This package
implements the same `globalThis.ego` contract the app's native bridge provides,
backed by any CDP-capable Chromium already installed on the machine, and then
delegates execution to the unmodified `ego-browser` runtime. Everything the
runtime offers — `page`, `page.locator(...)`, `browser`, `taskSpaces`,
snapshots, screenshots, waits — runs as-is.

The host model follows the Linux host prior art in #134 / #202 (shared profile,
task spaces as tracked tab sets with ownership), rebuilt for Windows: Edge
detection, `%LOCALAPPDATA%` state, no POSIX daemon — the detached browser
itself is the persistent process, so there is nothing extra to manage.

```
agent script ──> ego-browser runtime (unmodified)
                     │  globalThis.ego
                     ▼
             ego-windows-host bridge
                     │  two CDP websockets (loopback)
                     ▼
          stock Edge / Chrome (detached, dedicated profile)
```

## Quick start

```powershell
cd package/ego-browser; npm ci; npm run build
cd ../ego-windows-host; npm ci; npm run build

node bin/ego-windows-host.mjs -e "
const task = await taskSpaces.useOrCreate('demo')
await browser.openOrReuseTab('https://example.com', { wait: true })
console.log(await page.snapshot())
"
```

The first call launches the browser detached with a dedicated profile; it stays
running, so later calls (and later agent heredocs) reattach to the same tabs and
task spaces. Input forms: a script file (`ego-windows-host task.js`), inline
`-e <code>`, or stdin. A leading `nodejs` argument is accepted so agent
instructions written for `ego-browser nodejs` carry over.

`--doctor` reports the detected browser, endpoint state, and task spaces.

## Environment

| Variable                | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `EGO_HOST_BROWSER_PATH` | Full path to `msedge.exe` / `chrome.exe` (default: auto-detect, Edge first) |
| `EGO_HOST_DEBUG_PORT`   | CDP port for the hosted browser (default `9522`)                            |
| `EGO_HOST_STATE_DIR`    | State root (default `%LOCALAPPDATA%\ego-windows-host`)                      |
| `EGO_HOST_HEADLESS`     | `1` to launch the browser headless                                          |

## How task spaces are emulated

A task space is a named, persisted set of tabs plus an ownership state
(`agent` / `agentDelegatedToUser` / `user`), exactly the surface the runtime's
`taskSpaces` helpers expect:

- `useOrCreate` / `switch` / `claim` select a space; a fresh space opens one
  blank tab so the runtime always has a session target.
- `handOff` pauses agent commands: every CDP send and snapshot fails with the
  stable `EGO_TASK_SPACE_USER_IN_CONTROL` code until `takeOver`, so the
  runtime's hard-stop guidance and `waitForAgentControl` behave like they do
  against the real app.
- `complete(..., { keep: true })` leaves the tabs open and hands the space to
  the user; `{ keep: false }` closes the space's tabs and forgets it.
- Tabs created through raw CDP (`Target.createTarget`) are sniffed off the
  passthrough channel and tracked into the current space, so bookkeeping stays
  consistent however the runtime opens tabs.

State lives in `spaces.json` under the state dir, written atomically.

## Honest limitations vs the real app

- **Snapshot quality.** `ego.snapshot()` here is a plain projection of
  Chromium's accessibility tree with `[@backendNodeId]` refs. It is good enough
  for semantic locators and `@ref` actions on ordinary DOM pages, but it is not
  the app's kernel-level snapshot (deeply nested iframes and canvas-heavy
  surfaces will be weaker).
- **Profile.** The hosted browser uses its own persistent profile. Logins
  accumulate there (log in once via `taskSpaces.handOff`), but it does not
  import your daily browser's cookies the way ego lite's Chrome migration does.
  This host never touches your daily browser profile.
- **No Spaces UI.** Ownership is enforced at the bridge, but there is no
  browser chrome showing which space an agent holds.
- **Security.** The browser exposes CDP on a loopback port; any local process
  can connect to it. Do not point `EGO_HOST_DEBUG_PORT` at a non-loopback
  interface, and prefer a dedicated profile (the default) over a copy of a
  profile holding sensitive sessions.

## Tests

```powershell
npm test   # build + typecheck + node --test, no real browser required
```

Unit tests stub the browser side entirely. The real-browser path is exercised
manually (see the PR that introduced this package for a full transcript against
Edge on Windows 11).
