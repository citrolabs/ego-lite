# ego-linux-host

ego-shaped Linux host for ego lite: a long-lived Chromium supervisor plus CLI shim so agents can run `ego-browser` heredocs against a shared browser on Linux/WSL.

This is **not** the Citro/macOS ego app. It is an OSS-friendly host that approximates the ego product model (shared profile/logins, Task Spaces as tab sets + ownership, CDP-only) on stock Chromium.

**Design spec:** [`docs/superpowers/specs/2026-07-23-ego-linux-host-design.md`](../../docs/superpowers/specs/2026-07-23-ego-linux-host-design.md)

## Status

MVP host: daemon, CDP bridge, Task Spaces, CLI shim, doctor diagnostics, stale-socket recovery, and Chrome respawn on next ensure.

**MVP acceptance (2026-07-23):** manual checklist PASS on Linux headed Chrome — `ego-browser` on PATH, `--doctor` healthy, example.com smoke (title + snapshot), user-tab isolation, two-space disjoint tabs, space reuse by name, handoff → `EGO_TASK_SPACE_USER_IN_CONTROL` → `takeOver` recovery, `package/ego-browser` and `package/ego-linux-host` unit tests green. Details: `.superpowers/sdd/task-11-report.md`.

## Requirements

- Linux (or WSL with Linux-side Chrome/Chromium)
- Node.js ≥ 22
- ESM only
- Chrome/Chromium for a live browser (not required for unit tests)

## Install (recommended)

From the monorepo root, use the skill installer (builds harness + host, symlinks `ego-browser` into `~/.local/bin`, creates data dirs, detects Chrome, runs `--doctor`):

```bash
bash skills/ego-browser/scripts/install-linux.sh
```

Notes:

- This is the **ego-shaped Linux host**, not the Citro/macOS ego lite DMG. Do not run `skills/ego-browser/scripts/install.sh` on Linux.
- Ensure `~/.local/bin` is on your `PATH` (`export PATH="$HOME/.local/bin:$PATH"`).
- Headed: prefer WSLg / native display (`DISPLAY` set). Headless: `export EGO_HEADLESS=1`.
- Non-standard Chrome: `export EGO_CHROME_PATH=/path/to/chrome`.
- **Profile seed** (`seedFromChrome` / future `--seed-chrome`): off by default and **risky** (can corrupt a live Chrome profile). See install docs; do not enable unless Chrome is closed and you accept the risk.

Details and troubleshooting: [`skills/ego-browser/references/install.md`](../../skills/ego-browser/references/install.md) (section **Install steps (Linux / WSL)**).

Manual alternative (same outcome as the installer steps):

```bash
cd package/ego-browser && npm ci && npm run build
cd ../ego-linux-host && npm ci && npm run build
mkdir -p ~/.local/bin ~/.local/share/ego-lite
ln -sfn "$(pwd)/bin/ego-browser.mjs" ~/.local/bin/ego-browser
export PATH="$HOME/.local/bin:$PATH"
ego-browser --doctor
```

## Build and test

```bash
npm install
npm run build     # esbuild: src/**/*.ts → dist/
npm run typecheck
npm test          # build + typecheck + node --test dist/**/*.test.js
```

Default `npm test` is Chrome-free. Opt-in E2E (example.com title + snapshot) is gated on `EGO_LINUX_E2E=1`.

### End-to-end smoke

Full smoke needs:

1. Built helper harness: `cd package/ego-browser && npm ci && npm run build` (produces `dist/src/run.js`)
2. Chrome/Chromium on `PATH`, or `EGO_CHROME_PATH`
3. A display (`DISPLAY` set) for headed mode, or `EGO_HEADLESS=1`

```bash
# from package/ego-linux-host
./scripts/smoke.sh
# or
EGO_LINUX_E2E=1 npm test
```

Without Chrome + display, skip the smoke script; unit/integration tests still pass.

## Path defaults

| Helper | Env override | Default |
|--------|--------------|---------|
| `defaultDataDir()` | `EGO_DATA_DIR` | `$XDG_DATA_HOME/ego-lite` or `~/.local/share/ego-lite` |
| `defaultConfigDir()` | `EGO_CONFIG_DIR` | `$XDG_CONFIG_HOME/ego-lite` or `~/.config/ego-lite` |
| `defaultProfileDir()` | `EGO_USER_DATA_DIR` | `<dataDir>/profile` |
| `defaultSocketPath()` | `EGO_HOST_SOCK` | `<dataDir>/host.sock` |
| `defaultCdpPort()` | `EGO_CDP_PORT` | `9222` |

## Diagnostics (`ego-browser --doctor`)

Reports (among others): `chromePath`, `chromeRunning`, `cdpPort`, `cdpUp`, `profileDir`, `socketPath`, `daemonPid`, `spaceCount`, `selectedSpace`, `headless`, `displayEnv`, `harnessPath`.

Hardening behavior:

- **Stale socket**: if `host.sock` exists but ping fails, the CLI unlinks it and restarts the daemon.
- **Chrome death**: the next ego RPC that needs the browser re-runs `ensureChrome` (attach if CDP is back, otherwise respawn). Failures surface as `EGO_BROWSER_UNAVAILABLE` with clear text.

## Source layout

```text
package/ego-linux-host/
  package.json
  tsconfig.json
  scripts/build.mjs
  bin/
    ego-browser.mjs
    ego-linux-hostd.mjs
  src/
    *.ts
  dist/                 # build output (gitignored)
```

## Related

- Helper harness: [`package/ego-browser`](../ego-browser)
- Agent skill: [`skills/ego-browser`](../../skills/ego-browser)
