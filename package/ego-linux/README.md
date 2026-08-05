# ego-browser, Linux port

Upstream ego lite runs on macOS only: the browser ships as a `.dmg`, and the
`ego-browser` harness talks to it through native bindings the app injects as
`globalThis.ego`.

This package supplies that object on Linux, backed by a stock Chromium over CDP.
**The harness itself is unmodified** — every helper, locator, driver and format
in `package/ego-browser/` is upstream code running as-is.

## Install

Requires Node >= 22 and any Chrome/Chromium/Brave/Edge build on `PATH`.

```bash
cd package/ego-browser && CI=true npm ci && npm run build   # build the upstream harness
cd ../ego-linux && npm test                                  # verify the port (headless)
```

`CI=true` is required, not cosmetic: the harness's `prepare` script runs
`lefthook install`, which fails on any machine with a global `core.hooksPath`
set. The script's own guard is `[ "$CI" = "true" ] && exit 0`, so this is
upstream's intended escape hatch rather than a workaround.

Put the CLI on your PATH:

```bash
ln -s "$PWD/bin/ego-browser.mjs" ~/.local/bin/ego-browser
```

## Use

Identical to upstream — a heredoc of JS on stdin:

```bash
ego-browser <<'JS'
const task = await taskSpaces.useOrCreate('research task')
await page.goto('https://example.com')
console.log(await page.snapshot())
JS
```

Linux-only commands:

| Command | What it does |
|---|---|
| `ego-browser --status` | connection state of the backing browser |
| `ego-browser --open` | open the shared agent browser window |
| `ego-browser --stop` | terminate the backing browser and clear its profile lock |
| `ego-browser --import-chrome-profile` | copy your real Chrome profile in, so agent tasks inherit your logins |
| `ego-browser --install-desktop-entry` | add it to your app launcher, with an icon |
| `ego-browser --headless` | run the backing browser headless (first launch only) |

### App launcher entry

The macOS build installs as an app you click to open. `--install-desktop-entry`
gives the Linux port the same affordance — an XDG desktop entry plus a scalable
icon:

```bash
ego-browser --install-desktop-entry
```

It writes `~/.local/share/applications/ego-lite-linux.desktop` and
`~/.local/share/icons/hicolor/scalable/apps/ego-lite-linux.svg`, then refreshes
the desktop and icon caches. Launching it runs `--open`, which brings up the
shared agent browser window. The icon is upstream's mark with a badge, so a
Linux-port window is never mistaken for an upstream build.

The backing browser is launched once and **persists between invocations** — each
heredoc is its own short-lived Node process, so the browser, not the process, is
what has to survive. It uses a dedicated profile under
`~/.local/share/ego-lite-linux/profile`, which is why `--import-chrome-profile`
exists: it is the Linux equivalent of ego lite's "migrate your Chrome data"
onboarding step.

Environment overrides: `EGO_LINUX_CHROME` (browser binary),
`EGO_LINUX_PROFILE` (profile dir), `EGO_LINUX_CDP_URL` (attach to an
already-running DevTools endpoint instead of launching).

### What the launcher normalises, and why

Two settings are forced on the agent profile because inheriting them silently
breaks coordinate-based automation:

- **Page zoom is reset to 100% on every launch.** `--import-chrome-profile`
  copies real Chrome preferences, zoom included. At 150% zoom a 1280px window
  lays out as 853 CSS px, so page content the agent expects on screen falls
  below the fold: element coordinates hit-test to nothing, clicks land on
  nothing, and `Input.dispatchMouseEvent` can hang outright. This was not
  theoretical — it caused every canvas drawing case in the upstream e2e suite to
  fail until it was fixed.
- **The window is launched at 1280x900 with device scale factor 1**, so page
  layout does not depend on the desktop's HiDPI setting.

The launcher also clears Chrome's `SingletonLock` before starting. A browser
killed without a clean shutdown leaves that lock, and every later launch then
aborts with "Failed to create a ProcessSingleton". Since `launch()` only runs
after no DevTools endpoint answered, a lock still held by a live process means
an unreachable orphan of ours, which is terminated first.

## Fidelity

The harness uses 15 native methods plus 2 callbacks. All are implemented; two
areas are degraded, and both degradations are structural rather than unfinished
work.

| Native surface | Backed by | Fidelity |
|---|---|---|
| `sendCDPMessage`, `onCDPMessage`, `onSendCDPMessageError` | WebSocket to Chrome's browser endpoint | **Exact.** Chrome's flat CDP wire format is byte-identical to what the harness sends and parses, so this is a passthrough, not a translation. |
| `listTabs`, `createTab` | `Target.getTargets` / `Target.createTarget` | **Exact**, except `active`: CDP cannot report which tab is focused, so the DevTools HTTP endpoint's most-recently-used ordering stands in. It also tracks tabs the user switches to by hand. |
| `getBrowserVersion` | `Browser.getVersion` | Exact. |
| `upgradeBrowser`, `animationHighlightMouseToPosition` | no-ops | App-lifecycle and cosmetic; nothing to do on Linux. |
| `snapshot` | `DOMSnapshot.captureSnapshot` + role/name computation | **Refs exact, content rebuilt.** See below. |
| the 9 task-space methods | one Chrome window per space | **Degraded by construction.** See below. |

Verified against upstream's own real-browser e2e suite (45 cases, ~525
assertions), which drives this CLI exactly as it drives the macOS app.

### snapshot

The `refs` half is exact. `browserSnapshotRefsToRefMap()` keys the ref map by
`String(backendNodeId)`, and CDP hands out `backendNodeId`s directly — so `@N`
and `ref=N` resolve against genuine node identities, not a reimplementation.

The `content` half is rebuilt, since the native snapshot is closed source. One
`DOMSnapshot.captureSnapshot` call returns every document — iframes included,
nested to any depth — with each node's `backendNodeId`, attributes and layout
box. Hierarchy, layout-driven visibility and iframe piercing therefore come from
the browser itself; roles, accessible names and `loc=` locators are computed
here. Emitted `loc=` values are resolved by upstream's own `locator-query.ts`,
so they are validated against the real resolver rather than an invented format.

Not claimed: parity with the native snapshot's output. It is a different tree
built from the same underlying facts.

### Task spaces

A native Space is isolated *and* inherits your login state. On stock Chromium
those two properties pull apart:

- `Target.createBrowserContext` → real isolation, but an empty cookie jar
- a separate window → your real logins, but no isolation

Login inheritance wins, because that is what agent tasks actually depend on. A
space owns a tracked set of tabs plus its ownership state (`agent` /
`agentDelegatedToUser` / `user`), with working `switch` / `claim` / `handOff` /
`takeOver` / `complete` semantics; switching to a space puts the agent back on
that space's page.

Spaces deliberately do **not** get their own browser window, though that was the
first design. Headless Chrome does not render tabs in background windows, so
`document.elementFromPoint` returned null for any page in a non-foreground
window. That broke hit-testing, which in turn tripped the harness's input
fallback (`driver/pointer.ts` `finishDragProbe`) into re-synthesising drags that
had already landed — the canvas cases variously failed or counted double
strokes. One window with tracked tab sets fixed all of it.

**What does not work:**

- *Two spaces logged into the same site as different users.* They share one
  cookie jar.
- *A per-space `listTabs`.* The native app lists only the selected Space's tabs;
  here `listTabs` is browser-wide. This is not an unfinished feature — CDP's
  `Target.createTarget` accepts no window id, so a tab opened for a space can
  land in a different window and the space-to-tab mapping drifts. Three
  heuristics were tried and measured against the upstream e2e suite (MRU
  ordering, "the tab the harness is attached to", "the tab we just created").
  Each traded one failure for another: hiding a tab the harness still held made
  `switchTab` fail with "target not found"; keeping it visible leaked one
  space's tabs into another's list. Reporting every page tab is stable and
  honest, so that is what it does.

Ownership is advisory here. The native bridge enforces the user-control boundary
inside the app; nothing on Linux can stop an agent from driving a window the
user has taken over, so `EGO_TASK_SPACE_USER_IN_CONTROL` is never raised.

## Verification

Two suites, and they must be run one at a time — both drive a browser.

**`npm test` (this package)** drives the real CLI headless against a local
fixture: navigation, snapshot content, refs resolving to coordinates,
synthesised clicks landing on elements, locator fills, two-level iframe
piercing, screenshots, and task-space lifecycle. It uses a throwaway profile and
state dir, so it never touches a browser your agent sessions are using.

**Upstream's real-browser e2e suite** (`cd ../ego-browser && npm run e2e`, with
`ego-browser` on PATH) is the real measure: 45 cases, ~520 assertions, driving
this CLI exactly as it drives the macOS app.

**43 of 45 cases pass** on an unloaded machine.

Two failures are permanent, and neither is a port defect:

| Case | Why it cannot pass |
|---|---|
| `macOS bare Meta input isolation` | Asserts `process.platform === "darwin"`. |
| `regression PWB-10 permission capability` | Asserts that `Browser.grantPermissions` with `clipboardReadWrite` is *rejected* — an ego lite limitation. Stock Chromium supports it, so the port is more capable than the assertion allows. |

Everything else passes: navigation, observation, task spaces, pointer input,
keyboard, downloads, screencast, fetch, canvas drawing, the Playwright
regression set, and the adversarial cases.

### Known flake: canvas drawing under load

The three canvas cases intermittently count one stroke too many
(`expected 1, got 2`). This is a timing race in the *upstream* harness, not in
the shim, and it is worth knowing about because it can bite any drag-heavy work:

`driver/pointer.ts` `finishDragProbe` waits **50 ms** for a trusted `mouseup` on
the drag's end element. If it has not seen one by then, it assumes the real
input never landed and re-synthesises the entire drag in JavaScript. When the
real events did land but arrived late, the page gets both — one trusted drag and
one synthetic one.

Anything that adds latency trips it. Running the screencast case immediately
before the canvas cases reproduces it reliably (drag time goes from ~1.2 s to
~4.1 s), and so does general machine load. The same code, unchanged, produced
six clean runs in a row and later four failing ones on the same box, so the
outcome tracks the machine rather than the port.

Fixing it properly means raising that 50 ms window or making the fallback
conditional on evidence the input actually failed — a change to
`package/ego-browser`, which this port deliberately leaves untouched. Nothing in
the shim layer can suppress the fallback without also removing
`sendCDPMessage`, which everything else depends on.
