# Install ego lite on Windows

Read `install.md` first; it covers upgrading an older ego lite and the onboarding step shared by every platform. This file has the Windows install steps, the commands that confirm the installation, and Windows troubleshooting.

## Run the installer

There is no install script for Windows. Have the user download the installer from https://lite.ego.app/ and run it, then open ego lite.

After the app opens, the user completes the first-run onboarding in the app (see `install.md`). Onboarding registers the `ego-browser` command on the PATH. The PATH entry only reaches processes started afterwards, so open a new terminal before checking for the command.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, open a new terminal and confirm the command is ready. The command depends on the shell.

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

- **SmartScreen blocks the installer**: have the user choose "More info" and then "Run anyway" in the SmartScreen dialog.
- **Command still unavailable after onboarding**: open a new terminal first, because an existing one keeps the PATH it started with. Otherwise have the user reopen ego lite, finish onboarding, and retry.
