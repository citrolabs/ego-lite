# Install ego lite on Windows

Read `install.md` first; it covers upgrading an older ego lite and the onboarding step shared by every platform. This file has the Windows install steps, the commands that confirm the installation, and Windows troubleshooting.

## Run the install script

The install script lives at `scripts/install.ps1` in this skill and supports Windows 10 or later on x64 and Arm64. If ego lite is already installed, it changes nothing and prints the path of `ego-browser`. Otherwise it downloads the official installer, checks its signature, runs it, and then starts onboarding, which opens the ego lite app.

Installing usually raises a Windows permission prompt (User Account Control) for "ego Installer" from CITRO LABS PTE. LIMITED. Started from your terminal, the prompt can open behind other windows or only flash on the taskbar, so tell the user to look for it and choose **Yes** before you run the script. Only the user can answer it; while it is open, the script repeats the reminder every minute.

Before running the script, note:

- Use the full command below. Shortened to `powershell -File`, it fails under the default execution policy with "running scripts is disabled on this system".
- The script waits for the installer and for the user to answer the prompt, which can take several minutes, so give the command a timeout of at least 10 minutes.
- Git Bash keeps only the low 8 bits of an exit code, so a failure such as 75003 shows up as 251. Read the full code from the `error:` line on stderr.

Run it from PowerShell, cmd, or Git Bash, with the script's actual path under this skill's directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill directory>\scripts\install.ps1"
```

The script takes no arguments and writes its messages to stderr. Exit code `0` means ego lite is installed and onboarding has started, or that it was already installed; it does not mean the user has finished onboarding. Any other code is a failure, and the `error:` line says what to do next.

After the script finishes, the user completes the first-run onboarding in the app (see `install.md`). Wait for the user to confirm they've finished it before continuing. Onboarding registers the `ego-browser` command on the PATH.

## After installing: confirm `ego-browser` is available

The PATH entry only reaches programs started after it was added, so your terminal, and any terminal your session starts, may not find `ego-browser` yet. Until your session restarts, use the full path the script printed (`Current terminal: run ego-browser using the full path "..."`) in place of `ego-browser` in the commands below. In PowerShell, run a quoted path with `&`, for example `& "<full path>" skill`.

Once the user has finished onboarding, confirm the command is ready. The command depends on the shell.

PowerShell:

```powershell
Get-Command ego-browser
```

cmd:

```bat
where ego-browser
```

Git Bash:

```bash
command -v ego-browser
```

Once the command exists, verify the runtime. In PowerShell or cmd, where heredoc does not exist:

```powershell
ego-browser nodejs -e "console.log('ego-browser ready')"
```

In Git Bash:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready. Finally confirm that the installed ego lite prints its usage guide:

```powershell
ego-browser skill
```

Then return to the user's original task, as `install.md` describes.

## Troubleshooting

- **`updater registration failed (exit code 75003, ...)`**: the user chose **No**, or the prompt timed out, while the script ran from your terminal. Ask the user before running the script again, because the rerun raises another prompt they must answer with **Yes**. Otherwise have them download the installer from https://lite.ego.app/ and run it themselves, outside your terminal.
- **The script cannot run at all**: have the user download the installer from https://lite.ego.app/, run it, then open ego lite. If SmartScreen blocks the installer, have the user choose "More info" and then "Run anyway" in the SmartScreen dialog.
- **Command still unavailable after onboarding**: use the full path the script printed (see above), or have the user open a new terminal. Otherwise have the user reopen ego lite, finish onboarding, and retry.
