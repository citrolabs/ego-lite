# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on a browser it can drive. On macOS that is the ego lite app, which provides the `ego-browser` command. On Linux there is no app bundle: the same harness drives a stock Chrome/Chromium over CDP. Either way, once the install is done the `ego-browser` command is on PATH and there are no further environment issues.

ego lite website: https://lite.ego.app/

## Install steps

One script covers both platforms — it reads `uname -s` and runs the matching flow, so you do not have to pick:

```bash
sh skills/ego-browser/scripts/install.sh
```

On an unsupported platform it stops with `unsupported platform: <name>` rather than half-installing.

### macOS

The script will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Onboarding is a step the user completes in the GUI. After the script opens ego lite, wait for the user to confirm they've finished onboarding before continuing.

### Linux

There is nothing to download. The script builds the harness in `package/ego-browser` and links the CDP shim from `package/ego-linux` onto PATH as `ego-browser`, so run it from a checkout of this repository.

Requires Node >= 22 and any Chrome/Chromium/Brave/Edge on PATH. The script checks both before touching anything and stops with a clear error rather than half-installing. Set `EGO_LINUX_CHROME` to an absolute path to point it at a browser that is not on PATH, and `EGO_LINUX_BIN_DIR` to link somewhere other than `~/.local/bin`.

There is no GUI onboarding step: when the script finishes, the command is ready.

Two follow-ups it deliberately does not run for you, because both touch user data:

```bash
ego-browser --import-chrome-profile       # inherit the user's real logins
ego-browser --install-desktop-entry       # app launcher icon
```

Equivalent by hand, if you would rather see each step:

```bash
cd <repo>/package/ego-browser
CI=true npm ci && CI=true npm run build   # CI=true is required, not cosmetic: the
                                          # prepare script runs lefthook install,
                                          # which fails when core.hooksPath is set

ln -sf <repo>/package/ego-linux/bin/ego-browser.mjs ~/.local/bin/ego-browser
```

#### Linux-only commands

| Command | What it does |
|---|---|
| `ego-browser --status` | backing browser connection state |
| `ego-browser --open` | open the shared agent browser window |
| `ego-browser --stop` | stop it and clear the profile lock |
| `ego-browser --import-chrome-profile` | copy the real Chrome profile in |
| `ego-browser --install-desktop-entry` | app launcher entry + icon |
| `ego-browser --headless` | run headless (first launch only) |

The browser persists between invocations — each heredoc is its own short-lived Node process, so the browser is what survives, not the process.

#### How Linux differs from the macOS app

- **`listTabs` is browser-wide**, not per task space. Task spaces still work (own tabs, ownership, `switch` / `claim` / `handOff` / `complete`), but CDP cannot place a tab in a chosen window, so per-space tab lists are not reproducible.
- **Spaces are isolated, but their login state is a copy.** Each space gets its own cookie jar, seeded from yours when the space is created — so your logins are there, but a login made inside one space does not appear in the others, and `localStorage` / IndexedDB / service workers are not carried at all.
- **Snapshot content is rebuilt** from `DOMSnapshot.captureSnapshot`. Refs (`@N`) are exact — they are real CDP `backendNodeId`s — but the tree's wording differs from the native snapshot.

Full details: `package/ego-linux/README.md`.

## After installing: confirm `ego-browser` is available

Confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime with a minimal heredoc:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready.

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — start from `taskSpaces.useOrCreate(name)` and proceed as usual.

## Troubleshooting

Any platform:

- **Command still unavailable after installing**: confirm `~/.local/bin` is on the PATH (see above).
- **Unsupported platform**: the script covers macOS and Linux. Elsewhere, have the user download and install from the ego lite website at https://lite.ego.app/.

macOS:

- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable after onboarding**: have the user reopen ego lite, finish onboarding, and retry.

Linux:

- **"no Chrome/Chromium/Brave/Edge found on PATH"**: install one, or set `EGO_LINUX_CHROME` to an absolute path.
- **"Chrome did not expose a DevTools port"**: a killed browser left a profile lock. `ego-browser --stop` clears it, then retry.
- **Clicks land on nothing / coordinates look wrong**: page zoom. The launcher pins the agent profile to 100%, but if a page was zoomed manually, reset it.
- **Duplicate drag events under heavy load**: `driver/pointer.ts` `finishDragProbe` waits a fixed 50 ms before re-synthesising a drag, so a trusted `mouseup` that lands later can be delivered twice. Retry when the machine is quieter.
