# Install ego-browser (Linux)

Read this only when the `ego-browser` command is missing, or when the user asks
to install it. For day-to-day browser work go back to `SKILL.md`.

This is the **Linux port**, not the macOS app. Upstream ego lite ships as a
macOS-only `.dmg`; on Linux the same `ego-browser` harness runs against a stock
Chromium through a CDP shim.

Source: [`NagyVikt/ego-lite-linux`](https://github.com/NagyVikt/ego-lite-linux),
an unofficial fork of `citrolabs/ego-lite`, published on branch `linux-port`
(checked out locally as `main`, which tracks it). On this machine the checkout
is at `~/Documents/ego-lite-linux`. Full details: `package/ego-linux/README.md`.

## Check first

```bash
command -v ego-browser && ego-browser --status
```

If that prints a path, the environment is ready — return to `SKILL.md`.

If the command is not found, `~/.local/bin` is probably off PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

## Install from scratch

Requires Node >= 22 and any Chrome/Chromium/Brave/Edge on PATH.

Run the install script from a checkout of the fork. It builds the harness,
links the CLI, and stops with a clear error rather than half-installing:

```bash
sh skills/ego-browser/scripts/install.sh
```

Optional follow-ups it does not do for you, because both touch user data:

```bash
ego-browser --import-chrome-profile       # inherit the user's real logins
ego-browser --install-desktop-entry       # app launcher icon
```

Equivalent by hand, if you would rather see each step:

```bash
cd <repo>/package/ego-browser
CI=true npm ci && npm run build          # CI=true is required: the prepare
                                          # script runs lefthook install, which
                                          # fails when core.hooksPath is set

ln -sf <repo>/package/ego-linux/bin/ego-browser.mjs ~/.local/bin/ego-browser
```

Verify:

```bash
ego-browser <<'JS'
console.log('ready: ' + JSON.stringify(await page.info()))
JS
```

## Linux-only commands

| Command | What it does |
|---|---|
| `ego-browser --status` | backing browser connection state |
| `ego-browser --open` | open the shared agent browser window |
| `ego-browser --stop` | stop it and clear the profile lock |
| `ego-browser --import-chrome-profile` | copy the real Chrome profile in |
| `ego-browser --install-desktop-entry` | app launcher entry + icon |
| `ego-browser --headless` | run headless (first launch only) |

The browser persists between invocations — each heredoc is its own short-lived
Node process, so the browser is what survives, not the process.

## What differs from the macOS app

- **`listTabs` is browser-wide**, not per task space. Task spaces still work
  (own tabs, ownership, `switch` / `claim` / `handOff` / `complete`), but CDP
  cannot place a tab in a chosen window, so per-space tab lists are not
  reproducible.
- **No isolation between spaces.** They share one cookie jar, which is the
  price of inheriting the user's real logins.
- **Snapshot content is rebuilt** from `DOMSnapshot.captureSnapshot`. Refs
  (`@N`) are exact — they are real CDP `backendNodeId`s — but the tree's
  wording differs from the native snapshot.

## Troubleshooting

- **"Chrome did not expose a DevTools port"** — a killed browser left a profile
  lock. `ego-browser --stop` clears it, then retry.
- **Clicks land on nothing / coordinates look wrong** — page zoom. The launcher
  pins the agent profile to 100%, but if a page was zoomed manually, reset it.
- **Duplicate drag events under heavy load** — a known upstream timing race
  (`driver/pointer.ts` `finishDragProbe` waits 50 ms before re-synthesising a
  drag). Retry when the machine is quieter.
