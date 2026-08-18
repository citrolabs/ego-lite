# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The `ego-browser` skill depends on a browser. On **macOS** the `ego-browser` command comes from the ego lite app; on **Linux** it is polyfilled over Chrome/Chromium via CDP (`EGO_LINUX=1` or auto-detect). Once installed, the environment is ready.

ego lite website: https://lite.ego.app/

## Quick install

```bash
sh skills/ego-browser/scripts/install.sh
```

The script auto-detects your OS.

## Platform details

### macOS

The install script (Darwin branch):

- Downloads the ego lite DMG for your arch (arm64/x64) from `cdn.ego.app`.
- Installs `ego lite.app` to `/Applications` (or `~/Applications`).
- Strips quarantine attrs, then `open`-launches the app.
- On first launch, ego lite asks whether to migrate Chrome data. Say **Yes** to inherit logins/cookies/extensions.

After the app launches, finish onboarding in the GUI, then verify:

```bash
command -v ego-browser
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

### Linux (new)

The install script (Linux branch):

- Detects your distro (`apt`/`dnf`/`pacman`/`zypper`).
- Looks for `google-chrome`, `google-chrome-stable`, `chromium-browser`, or `chromium` on `PATH`.
- If missing, offers to install `chromium` via your package manager (interactive prompt; set `EGO_BROWSER_ASSUME_YES=1` to auto-confirm in CI).
- Builds `package/ego-browser` (`npm ci && npm run build`) if not already built.
- Creates `~/.local/bin/ego-browser` as `exec node <repo>/package/ego-browser/dist/out/index.js "$@"`.
- Verifies with `node dist/out/index.js --help`.

Requirements on Linux:

- **Chrome or Chromium** (`google-chrome` ≥120 or `chromium` with CDP).
- **Node.js** ≥22.
- **Wayland**: if `WAYLAND_DISPLAY` is set, Chrome auto-detects Ozone (`--ozone-platform-hint=auto`). No extra config; the launcher adds it. If you see blank screens, try `google-chrome --ozone-platform-hint=wayland`.

After installing on Linux, verify:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
node package/ego-browser/scripts/doctor-linux.mjs          # diagnostics
EGO_LINUX=1 ego-browser nodejs <<'EOF'
console.log(await pageInfo())
EOF
```

The Linux shim uses headless Chrome with an ephemeral `--remote-debugging-port`. Task Spaces map to `Target.createBrowserContext` (isolated cookie jars), not separate processes.

## After installing: confirm `ego-browser` is available

```bash
command -v ego-browser
```

If not found, `~/.local/bin` is likely not on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Then verify the runtime:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready.

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with `SKILL.md` — e.g.:

```js
const task = await useOrCreateTaskSpace('my task')
await openOrReuseTab('https://example.com', { wait: true })
console.log(await pageInfo())
```

## Troubleshooting

### macOS

- **Download failed**: the script retries 3×; otherwise check your network.
- **Gatekeeper still blocks it**: allow ego lite under **System Settings → Privacy & Security**.
- **Command unavailable after onboarding**: ensure `~/.local/bin` is on `PATH`; reopen ego lite and re-run the script.

### Linux

- **Chrome/Chromium not found**: install manually:
  - Debian/Ubuntu: `sudo apt-get update && sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser`
  - Fedora: `sudo dnf install -y chromium`
  - Arch: `sudo pacman -Sy --noconfirm chromium`
  - Or install Google Chrome from https://www.google.com/chrome/
- **Sandbox / `--no-sandbox` errors**: the launcher already passes `--no-sandbox` and `--disable-dev-shm-usage` for CI/containers. If you still see sandbox failures inside Docker, run the container with `--shm-size=2g` or `--privileged`.
- **Wayland blank/offset rendering**: ensure you are not forcing `--ozone-platform-hint=x11`; let the launcher auto-detect. `node package/ego-browser/scripts/doctor-linux.mjs` reports your display server.
- **Port 9222 in use**: the Linux shim uses an ephemeral port (`--remote-debugging-port=0`), so it does not collide with an existing Chrome or Camofox on `:9377`.
- **Command still unavailable**: confirm `~/.local/bin` is on `PATH`:
  ```bash
  echo ":$PATH:" | grep -q ":$HOME/.local/bin:" || echo "add ~/.local/bin to PATH"
  ```

### All platforms

- **Command still unavailable after install**: confirm `~/.local/bin` is on `PATH` (see above); or reopen ego lite (macOS) and retry.
