# Install ego lite on macOS

Read `install.md` first; it covers upgrading an older ego lite and the onboarding step shared by every platform. This file has the macOS install steps, the commands that confirm the installation, and macOS troubleshooting.

## Run the install script

The install script lives at `scripts/install.sh` in this skill and supports macOS only (`uname -s` is `Darwin`). It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app (see `install.md`). Onboarding registers the `ego-browser` command on the PATH, usually under `~/.local/bin`.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready. Finally confirm that the installed ego lite prints its usage guide:

```bash
ego-browser skill
```

Then return to the user's original task, as `install.md` describes.

## Troubleshooting

- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above). Otherwise have the user reopen ego lite, finish onboarding, and retry.
