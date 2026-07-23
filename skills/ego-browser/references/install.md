# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on a working `ego-browser` command on `PATH`. On **macOS**, that command comes from the Citro **ego lite** app (DMG + onboarding). On **Linux / WSL**, this monorepo ships an **ego-shaped Linux host** (`package/ego-linux-host`) that approximates the same product model (shared Chromium profile, Task Spaces, CDP) without the proprietary Citro app.

ego lite website (macOS product): https://lite.ego.app/

---

## Install steps (Linux / WSL)

Use this path on Linux and WSL. **Do not** run the macOS DMG installer (`scripts/install.sh`) here — it only supports Darwin and downloads the Citro app.

This install builds the OSS packages in the monorepo and symlinks a CLI shim:

- Host: `package/ego-linux-host` (daemon + `ego-browser` shim)
- Harness: `package/ego-browser` (helper runtime injected into heredocs)

### Requirements

- Linux kernel (`uname -s` → `Linux`), including WSL2
- Node.js ≥ 22 and npm
- Chrome or Chromium **on the Linux side** (not Windows `chrome.exe` for MVP)
- For headed mode: a display (`DISPLAY` set) — prefer **WSLg** on Windows
- For headless: `EGO_HEADLESS=1` (opt-in; no GUI required)

### Run the installer

From the ego-lite repo root (adjust the path if your checkout lives elsewhere):

```bash
bash skills/ego-browser/scripts/install-linux.sh
```

What it does:

1. Checks Linux + Node ≥ 22
2. `npm ci` + `npm run build` for `package/ego-browser` and `package/ego-linux-host`
3. Creates data/config dirs (`~/.local/share/ego-lite`, `~/.config/ego-lite`)
4. Symlinks `~/.local/bin/ego-browser` → `package/ego-linux-host/bin/ego-browser.mjs`
5. Detects Chrome/Chromium (warns with install hints if missing; does not auto-`apt install`)
6. Checks that `~/.local/bin` is on `PATH`
7. Runs `ego-browser --doctor` (skip with `--no-doctor`)

Optional flags:

```bash
bash skills/ego-browser/scripts/install-linux.sh --no-doctor
bash skills/ego-browser/scripts/install-linux.sh --doctor   # default
```

### Optional profile seed (`--seed-chrome`) — risky, off by default

Copying cookies/logins from your **system Chrome** into the ego profile is **not** done by default and is not wired into the installer yet.

- Config flag `seedFromChrome` in `~/.config/ego-lite/config.json` defaults to `false` (feature flag only).
- A future installer `--seed-chrome` would copy only selected Default-profile dirs **when the source Chrome is fully closed**.
- Seeding while Chrome is running (or blindly copying a live profile) can **corrupt Chrome data**. Leave seeding disabled unless you understand that risk.

Until an explicit, guarded implementation lands, use Chrome’s own export/import or sign in again inside the ego profile.

### Headed vs headless (WSL notes)

| Mode | When | How |
|------|------|-----|
| Headed (preferred) | Interactive browsing, visual debug | WSLg or native Linux desktop; ensure `DISPLAY` is set |
| Headless | CI / no GUI | `export EGO_HEADLESS=1` before `ego-browser` |

MVP targets **Linux-side** Chrome/Chromium only. Pointing at Windows Chrome under `/mnt/c/...` is out of scope.

If Chrome lives in a non-standard path:

```bash
export EGO_CHROME_PATH=/opt/google/chrome/chrome
```

### Confirm install

```bash
command -v ego-browser
ego-browser --doctor
```

If `command -v` fails, put `~/.local/bin` on `PATH` (see below) and retry.

---

## Install steps (macOS only)

The install script lives at `scripts/install.sh` in this skill and supports **macOS only**. It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Onboarding is a step the user completes in the GUI. After the script opens ego lite, wait for the user to confirm they've finished onboarding before continuing.

---

## After installing: confirm `ego-browser` is available

Once install (and on macOS, onboarding) is done, confirm the command is ready:

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

On Linux, you can also run diagnostics without a full heredoc:

```bash
ego-browser --doctor
```

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — start from `taskSpaces.useOrCreate(name)` and proceed as usual.

## Troubleshooting

- **Linux / WSL**: use `scripts/install-linux.sh`, not the macOS DMG script. See **Install steps (Linux / WSL)** above.
- **Not macOS**: the DMG script supports macOS only (`uname -s` is `Darwin`). On Linux use `install-linux.sh`. On other platforms, check https://lite.ego.app/ or build from this monorepo.
- **This is not the Citro app on Linux**: the Linux host is an OSS-friendly approximation (shared Chromium + CDP + Task Spaces). It does not download or install `ego lite.app`.
- **Chrome missing on Linux**: install Chromium/Chrome for Linux, or set `EGO_CHROME_PATH`. The installer warns but does not run package managers without consent.
- **No display (WSL without WSLg)**: use `EGO_HEADLESS=1`, or enable WSLg / a display server.
- **Download failed (macOS)**: the DMG script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it (macOS)**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable**: confirm `~/.local/bin` is on the PATH (see above). On macOS, reopen ego lite, finish onboarding, and retry. On Linux, re-run `install-linux.sh` or re-create the symlink to `package/ego-linux-host/bin/ego-browser.mjs`.
