# ego GPU Mode controller

This optional macOS integration adds a GPU mode selector to the ego lite toolbar without modifying or re-signing the browser application.

## Install

```bash
sh skills/ego-browser/gpu-controller/install.sh
```

The installer opens `ego://extensions`. Enable Developer mode, choose **Load unpacked**, and select the extension directory printed by the installer. This is a one-time setup.

After installation, pin **ego GPU Mode** from the extensions menu. Selecting a mode saves the configuration and restarts ego lite automatically. The restart ends active Agent tasks, so finish or pause important work before switching.

The controller uses Chromium's own persistent `Local State` preference for normal, balanced, and software-rendering modes. Low-power mode requires the startup-only `--disable-webgl` switch, so the extension checks and reapplies it automatically after later normal launches.

On macOS, ego lite stores profile data under `Citro Labs/ego lite`, but its current Chromium build resolves user-level native messaging manifests from the Google Chrome compatibility directory. The installer handles both paths separately, and the host manifest only allows this extension's fixed ID.

## Security boundary

- The integration never edits `/Applications/ego lite.app`.
- The native messaging host only accepts the four predefined modes.
- The fixed extension ID is an allowlist, not code signing. Only load the installer-copied extension directory.
- The host preserves unrelated browser preferences and extension data.
- Applying a mode requires a browser restart because Chromium graphics initialization happens at process startup.

## Uninstall

Select **Normal** and let ego lite restart. Then remove **ego GPU Mode** from `ego://extensions` and run:

```bash
sh skills/ego-browser/gpu-controller/uninstall.sh
```
