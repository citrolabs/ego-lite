# ego GPU Mode controller

This optional macOS integration adds a GPU and background-power selector to the ego lite toolbar without modifying or re-signing the browser application.

## Install

```bash
sh skills/ego-browser/gpu-controller/install.sh
```

The installer opens `ego://extensions`. Enable Developer mode, choose **Load unpacked**, and select the extension directory printed by the installer. This is a one-time setup.

After installation, pin **ego GPU Mode** from the extensions menu. Selecting a mode saves the configuration and restarts ego lite automatically. The restart ends active Agent tasks, so finish or pause important work before switching.

The controller uses Chromium's own persistent `Local State` preference for normal and balanced modes. Low-power mode starts a local watchdog that hides ego lite after the browser loses focus. Clicking the ego lite Dock icon restores it, and the watchdog leaves it visible while it remains frontmost.

Software rendering is disabled on ego lite `0.4.6.12`: both Chromium's hardware-acceleration preference and `--disable-gpu` cause that build to exit with `SIGTRAP`.

On macOS, ego lite stores profile data under `Citro Labs/ego lite`, but its current Chromium build resolves user-level native messaging manifests from the Google Chrome compatibility directory. The installer handles both paths separately, and the host manifest only allows this extension's fixed ID.

## Security boundary

- The integration never edits `/Applications/ego lite.app`.
- The native messaging host only accepts the four predefined modes.
- The fixed extension ID is an allowlist, not code signing. Only load the installer-copied extension directory.
- The host preserves unrelated browser preferences and extension data.
- Mode changes restart the browser to apply `Local State` safely and remove stale startup flags from older controller versions.
- The low-power watchdog only reads ego lite's foreground/visibility state and hides that application after it loses focus.

## Uninstall

Select **Normal** and let ego lite restart. Then remove **ego GPU Mode** from `ego://extensions` and run:

```bash
sh skills/ego-browser/gpu-controller/uninstall.sh
```
