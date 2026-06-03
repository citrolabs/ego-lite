# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, go back to `SKILL.md`.

The ego-browser skill depends on the ego lite browser: the `ego-browser` command is provided by the ego lite app. Once ego lite is installed and you've gone through onboarding once, the environment is ready and there are no further environment issues.

ego lite website: https://lite.ego.app/

## Before installing: confirm with the user first

Before doing anything, explain the situation to the user and get their consent:

1. Tell the user: ego lite isn't installed in the current environment, so it has to be installed before ego-browser can be used.
2. Ask the user to confirm whether to install now.
3. Remind the user: after the install, they need to open ego lite and go through onboarding once, choosing to import data (bookmarks, login state, etc.) from Chrome or another browser as needed; onboarding also registers the `ego-browser` command on their PATH.

Continue only after the user agrees.

## Install steps (macOS only)

The install script lives at `scripts/install.sh` in this skill and supports macOS only. It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- Locate the `ego-browser` command bundled inside the app and start onboarding.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

When run with no arguments, the script goes straight to onboarding. If ego lite is already installed, the script skips the download and proceeds directly to onboarding.

The user then completes onboarding in the ego lite app:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Onboarding is a step the user completes in the GUI. After the script launches onboarding, wait for the user to confirm they've finished before continuing.

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

Once the command exists, verify the runtime with a minimal heredoc:

```bash
ego-browser nodejs <<'EOF'
cliLog('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready.

## After that, return to the original task

Once the environment is ready, return to the user's original task and continue with the task space flow in `SKILL.md` — start from `useOrCreateTaskSpace(name)` and proceed as usual.

## Troubleshooting

- **Not macOS**: the script supports macOS only (`uname -s` is `Darwin`). On other platforms, have the user download and install from the ego lite website at https://lite.ego.app/.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above); or have the user reopen ego lite, finish onboarding, and retry.
