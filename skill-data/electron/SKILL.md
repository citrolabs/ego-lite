---
name: electron
description: Automate Electron desktop apps (VS Code, Slack, Discord, Figma, Notion, Spotify, etc.) using ego-cli via Chrome DevTools Protocol. Use when the user needs to interact with an Electron app, automate a desktop app, connect to a running app, control a native app, or test an Electron application. Triggers include "automate Slack app", "control VS Code", "interact with Discord app", "test this Electron app", "connect to desktop app", or any task requiring automation of a native Electron application.
allowed-tools: Bash(ego-cli:*), Bash(npx ego-cli:*)
---

# Electron App Automation

Automate any Electron desktop app using ego-cli. Electron apps are built on Chromium and expose a Chrome DevTools Protocol (CDP) port that ego-cli can connect to, enabling the same snapshot-interact workflow used for web pages.

## Core Workflow

1. **Launch** the Electron app with remote debugging enabled
2. **Connect** ego-cli to the CDP port
3. **Snapshot** to discover interactive elements
4. **Interact** using element refs
5. **Re-snapshot** after navigation or state changes

```bash
# Launch an Electron app with remote debugging
open -a "Slack" --args --remote-debugging-port=9222

# Connect ego-cli to the app
ego-cli connect 9222

# Standard workflow from here
ego-cli snapshot -i
ego-cli click @e5
ego-cli screenshot slack-desktop.png
```

## Launching Electron Apps with CDP

Every Electron app supports the `--remote-debugging-port` flag since it's built into Chromium.

### macOS

```bash
# Slack
open -a "Slack" --args --remote-debugging-port=9222

# VS Code
open -a "Visual Studio Code" --args --remote-debugging-port=9223

# Discord
open -a "Discord" --args --remote-debugging-port=9224

# Figma
open -a "Figma" --args --remote-debugging-port=9225

# Notion
open -a "Notion" --args --remote-debugging-port=9226

# Spotify
open -a "Spotify" --args --remote-debugging-port=9227
```

### Linux

```bash
slack --remote-debugging-port=9222
code --remote-debugging-port=9223
discord --remote-debugging-port=9224
```

### Windows

```bash
"C:\Users\%USERNAME%\AppData\Local\slack\slack.exe" --remote-debugging-port=9222
"C:\Users\%USERNAME%\AppData\Local\Programs\Microsoft VS Code\Code.exe" --remote-debugging-port=9223
```

**Important:** If the app is already running, quit it first, then relaunch with the flag. The `--remote-debugging-port` flag must be present at launch time.

## Connecting

```bash
# Connect to a specific port
ego-cli connect 9222

# Or use --cdp on each command
ego-cli --cdp 9222 snapshot -i

# Auto-discover a running Chromium-based app
ego-cli --auto-connect snapshot -i
```

After `connect`, all subsequent commands target the connected app without needing `--cdp`.

## Tab Management

Electron apps often have multiple windows or webviews. Use tab commands to list and switch between them:

```bash
# List all available targets (windows, webviews, etc.)
ego-cli tab

# Switch to a specific tab by index
ego-cli tab 2

# Switch by URL pattern
ego-cli tab --url "*settings*"
```

## Webview Support

Electron `<webview>` elements are automatically discovered and can be controlled like regular pages. Webviews appear as separate targets in the tab list with `type: "webview"`:

```bash
# Connect to running Electron app
ego-cli connect 9222

# List targets -- webviews appear alongside pages
ego-cli tab
# Example output:
#   0: [page]    Slack - Main Window     https://app.slack.com/
#   1: [webview] Embedded Content        https://example.com/widget

# Switch to a webview
ego-cli tab 1

# Interact with the webview normally
ego-cli snapshot -i
ego-cli click @e3
ego-cli screenshot webview.png
```

**Note:** Webview support works via raw CDP connection.

## Common Patterns

### Inspect and Navigate an App

```bash
open -a "Slack" --args --remote-debugging-port=9222
sleep 3  # Wait for app to start
ego-cli connect 9222
ego-cli snapshot -i
# Read the snapshot output to identify UI elements
ego-cli click @e10  # Navigate to a section
ego-cli snapshot -i  # Re-snapshot after navigation
```

### Take Screenshots of Desktop Apps

```bash
ego-cli connect 9222
ego-cli screenshot app-state.png
ego-cli screenshot --full full-app.png
ego-cli screenshot --annotate annotated-app.png
```

### Extract Data from a Desktop App

```bash
ego-cli connect 9222
ego-cli snapshot -i
ego-cli get text @e5
ego-cli snapshot --json > app-state.json
```

### Fill Forms in Desktop Apps

```bash
ego-cli connect 9222
ego-cli snapshot -i
ego-cli fill @e3 "search query"
ego-cli press Enter
ego-cli wait 1000
ego-cli snapshot -i
```

### Run Multiple Apps Simultaneously

Use named sessions to control multiple Electron apps at the same time:

```bash
# Connect to Slack
ego-cli --session slack connect 9222

# Connect to VS Code
ego-cli --session vscode connect 9223

# Interact with each independently
ego-cli --session slack snapshot -i
ego-cli --session vscode snapshot -i
```

## Color Scheme

The default color scheme when connecting via CDP may be `light`. To preserve dark mode:

```bash
ego-cli connect 9222
ego-cli --color-scheme dark snapshot -i
```

Or set it globally:

```bash
AGENT_BROWSER_COLOR_SCHEME=dark ego-cli connect 9222
```

## Troubleshooting

### "Connection refused" or "Cannot connect"

- Make sure the app was launched with `--remote-debugging-port=NNNN`
- If the app was already running, quit and relaunch with the flag
- Check that the port isn't in use by another process: `lsof -i :9222`

### App launches but connect fails

- Wait a few seconds after launch before connecting (`sleep 3`)
- Some apps take time to initialize their webview

### Elements not appearing in snapshot

- The app may use multiple webviews. Use `ego-cli tab` to list targets and switch to the right one

### Cannot type in input fields

- Try `ego-cli keyboard type "text"` to type at the current focus without a selector
- Some Electron apps use custom input components; use `ego-cli keyboard inserttext "text"` to bypass key events

## Supported Apps

Any app built on Electron works, including:

- **Communication:** Slack, Discord, Microsoft Teams, Signal, Telegram Desktop
- **Development:** VS Code, GitHub Desktop, Postman, Insomnia
- **Design:** Figma, Notion, Obsidian
- **Media:** Spotify, Tidal
- **Productivity:** Todoist, Linear, 1Password

If an app is built with Electron, it supports `--remote-debugging-port` and can be automated with ego-cli.
