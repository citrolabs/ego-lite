# Experimental Linux host

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
| `EGO_LINUX_HEADLESS`    | `1` forces headless; `0` requires `DISPLAY` or `WAYLAND_DISPLAY`. Otherwise a display selects headed mode.                           |
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
session, or `--real-session` to preserve the current desktop's display environment
without starting Xvfb. For a Wayland-only check, run
`env -u DISPLAY node scripts/linux-smoke.mjs --real-session` from a Wayland session.
All modes use temporary profiles and local fixture pages.
