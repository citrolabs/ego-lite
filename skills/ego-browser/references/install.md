# Install or upgrade ego lite

Read this file only when `ego-browser` is not found, when `ego-browser skill` reports an unknown command, or when the user asks to install ego lite. For day-to-day browser work, run `ego-browser skill` and follow its output.

The ego-browser skill depends on the ego lite browser: the `ego-browser` command is provided by the ego lite app. Once ego lite is installed and you've completed onboarding, no additional setup is normally needed.

ego lite website: https://lite.ego.app/

## Upgrade an older ego lite

If `ego-browser` exists but `ego-browser skill` reports `Unknown command: skill`, the installed ego lite is older than this skill. Ask the user for approval, then run:

```bash
ego-browser upgrade
```

If `upgrade` is also an unknown command, reinstall with the steps below. Then continue with "After installing: confirm `ego-browser` is available".

## Install on macOS

The install script lives at `scripts/install.sh` in this skill and supports macOS only. It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app. Onboarding registers the `ego-browser` command on the PATH, usually under `~/.local/bin`.

## Install on Windows

There is no install script for Windows. Have the user download the installer from https://lite.ego.app/ and run it, then open ego lite.

## Onboarding

Onboarding is a step the user completes in the GUI, on either platform:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH.

After the app opens, wait for the user to confirm they've finished onboarding before continuing. On Windows the PATH entry only reaches processes started afterwards, so open a new terminal before checking for the command.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready.

macOS and Linux shells:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

PowerShell:

```powershell
Get-Command ego-browser
```

cmd:

```bat
where ego-browser
```

Once the command exists, verify the runtime. In Bash or Zsh:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

In PowerShell or cmd, where heredoc does not exist:

```powershell
ego-browser nodejs -e "console.log('ego-browser ready')"
```

Printing `ego-browser ready` means the environment is ready. Finally confirm that the installed ego lite prints its usage guide:

```bash
ego-browser skill
```

## After that, return to the original task

Once the environment is ready, return to the user's original task: run `ego-browser skill` and follow its output.

## Troubleshooting

- **Not macOS**: `scripts/install.sh` supports macOS only (`uname -s` is `Darwin`). On Windows and other platforms, have the user download and install from the ego lite website at https://lite.ego.app/.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it (macOS)**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **SmartScreen blocks the installer (Windows)**: have the user choose "More info" and then "Run anyway" in the SmartScreen dialog.
- **Command still unavailable after onboarding**: on macOS and Linux, confirm `~/.local/bin` is on the PATH (see above). On Windows, open a new terminal first, because an existing one keeps the PATH it started with. Otherwise have the user reopen ego lite, finish onboarding, and retry.

## Experimental Linux host

From a clone of this branch, with Node.js 22+ and Chrome or Chromium installed:

```sh
sh skills/ego-browser/scripts/install.sh
ego-browser skill
ego-browser nodejs <<'EOF_JS'
const task = await taskSpace('linux-demo');
const page = task.page('p1');
await page.goto('https://example.com');
console.log(await page.snapshot());
EOF_JS
```

The installer builds this checkout and creates `~/.local/bin/ego-browser`.
It asks before installing a missing browser. No system security policy is
changed. Linux activation happens after `.env` loading and browser discovery;
`EGO_LINUX=1` enables it explicitly (including CI), and `EGO_LINUX=0` disables it.
Existing native `ego` bindings are preserved.

The managed host owns Chrome through `--remote-debugging-pipe`; it never probes
port 9222 or attaches to an external browser. `EGO_LINUX_PORT` is rejected.
The Chrome sandbox stays enabled, including in CI. A system that cannot run
sandboxed Chrome must resolve that configuration itself; the host does not
silently disable the sandbox.

Configuration (process environment or the agent workspace's `.env`):

| Variable                | Meaning                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `EGO_CHROME_BIN`        | Executable path or command on PATH; otherwise Chrome/Chromium is discovered.                                                         |
| `EGO_LINUX_HEADLESS`    | `1` forces headless; `0` requires a desktop display. Otherwise a display selects headed mode.                                        |
| `EGO_LINUX_STATE_DIR`   | Private host directory; default is `$XDG_CACHE_HOME/ego-lite/linux` or `~/.cache/ego-lite/linux`. Use a short path for Unix sockets. |
| `EGO_BROWSER_STATE_DIR` | Optional page-label/ref ledger location; defaults to the Linux host's private directory.                                             |

A host is shared by CLI rounds using the same build and configuration. Task
spaces use separate off-the-record BrowserContexts, including separate cookies
and local storage. Only the synthetic `Default` profile is offered; personal
Chrome profiles and their logins are not imported. Unknown profile ids fail.
Task ids, tabs, ownership, page labels and refs survive CLI exit while that host
is alive. Host restart, browser crash, build/configuration changes, or 30 minutes
without connected clients ends that session; off-the-record browser data is not
saved across host restarts. Old task ids are not reused.

On a desktop, `task.handOff()` activates the owned window and blocks subsequent
agent API/CDP operations, including existing sessions, until explicit takeover.
`task.finish()` leaves the task user-owned; `task.close()` disposes its context.
Headless handoff and finish that retains tabs fail explicitly because there is no user window; `task.finish({ keep: [] })` can close an entirely agent-owned task.
Use `takeOverTaskSpace(task.id)` only when the user has authorized taking back
control. The Linux host has no native Ego Lite Spaces UI or permission-prompt
integration. Its snapshot currently covers the main document AX tree; snapshots
of iframe contents are not yet equivalent to native Ego Lite. Browser-wide CDP
capabilities are deliberately restricted to protect other task contexts.

Stop the host and discard its contexts with:

```sh
ego-browser stop
```

For read-only diagnostics after building, run
`node package/ego-browser/scripts/doctor-linux.mjs --json` from the repo root.
For isolated integration checks, run `node scripts/linux-smoke.mjs` from
`package/ego-browser`; add `--headed` to verify handoff under a private Xvfb
session. Both modes use temporary profiles and local fixture pages.
