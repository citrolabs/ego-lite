# Command Reference

Complete reference for all ego-cli commands. For quick start and common patterns, see SKILL.md.

## Navigation

```bash
ego-cli open <url>      # Navigate to URL (aliases: goto, navigate)
                              # Supports: https://, http://, file://, about:, data://
                              # Auto-prepends https:// if no protocol given
ego-cli back            # Go back
ego-cli forward         # Go forward
ego-cli reload          # Reload page
ego-cli close           # Close browser (aliases: quit, exit)
ego-cli connect 9222    # Connect to browser via CDP port
```

## Snapshot (page analysis)

```bash
ego-cli snapshot            # Full accessibility tree
ego-cli snapshot -i         # Interactive elements only (recommended)
ego-cli snapshot -c         # Compact output
ego-cli snapshot -d 3       # Limit depth to 3
ego-cli snapshot -s "#main" # Scope to CSS selector
```

## Interactions (use @refs from snapshot)

```bash
ego-cli click @e1           # Click
ego-cli click @e1 --new-tab # Click and open in new tab
ego-cli dblclick @e1        # Double-click
ego-cli focus @e1           # Focus element
ego-cli fill @e2 "text"     # Clear and type
ego-cli type @e2 "text"     # Type without clearing
ego-cli press Enter         # Press key (alias: key)
ego-cli press Control+a     # Key combination
ego-cli keydown Shift       # Hold key down
ego-cli keyup Shift         # Release key
ego-cli hover @e1           # Hover
ego-cli check @e1           # Check checkbox
ego-cli uncheck @e1         # Uncheck checkbox
ego-cli select @e1 "value"  # Select dropdown option
ego-cli select @e1 "a" "b"  # Select multiple options
ego-cli scroll down 500     # Scroll page (default: down 300px)
ego-cli scrollintoview @e1  # Scroll element into view (alias: scrollinto)
ego-cli drag @e1 @e2        # Drag and drop
ego-cli upload @e1 file.pdf # Upload files
```

## Get Information

```bash
ego-cli get text @e1        # Get element text
ego-cli get html @e1        # Get innerHTML
ego-cli get value @e1       # Get input value
ego-cli get attr @e1 href   # Get attribute
ego-cli get title           # Get page title
ego-cli get url             # Get current URL
ego-cli get cdp-url         # Get CDP WebSocket URL
ego-cli get count ".item"   # Count matching elements
ego-cli get box @e1         # Get bounding box
ego-cli get styles @e1      # Get computed styles (font, color, bg, etc.)
```

## Check State

```bash
ego-cli is visible @e1      # Check if visible
ego-cli is enabled @e1      # Check if enabled
ego-cli is checked @e1      # Check if checked
```

## Screenshots and PDF

```bash
ego-cli screenshot          # Save to temporary directory
ego-cli screenshot path.png # Save to specific path
ego-cli screenshot --full   # Full page
ego-cli pdf output.pdf      # Save as PDF
```

## Video Recording

```bash
ego-cli record start ./demo.webm    # Start recording
ego-cli click @e1                   # Perform actions
ego-cli record stop                 # Stop and save video
ego-cli record restart ./take2.webm # Stop current + start new
```

## Wait

```bash
ego-cli wait @e1                     # Wait for element
ego-cli wait 2000                    # Wait milliseconds
ego-cli wait --text "Success"        # Wait for text (or -t)
ego-cli wait --url "**/dashboard"    # Wait for URL pattern (or -u)
ego-cli wait --load networkidle      # Wait for network idle (or -l)
ego-cli wait --fn "window.ready"     # Wait for JS condition (or -f)
```

## Mouse Control

```bash
ego-cli mouse move 100 200      # Move mouse
ego-cli mouse down left         # Press button
ego-cli mouse up left           # Release button
ego-cli mouse wheel 100         # Scroll wheel
```

## Semantic Locators (alternative to refs)

```bash
ego-cli find role button click --name "Submit"
ego-cli find text "Sign In" click
ego-cli find text "Sign In" click --exact      # Exact match only
ego-cli find label "Email" fill "user@test.com"
ego-cli find placeholder "Search" type "query"
ego-cli find alt "Logo" click
ego-cli find title "Close" click
ego-cli find testid "submit-btn" click
ego-cli find first ".item" click
ego-cli find last ".item" click
ego-cli find nth 2 "a" hover
```

## Browser Settings

```bash
ego-cli set viewport 1920 1080          # Set viewport size
ego-cli set viewport 1920 1080 2        # 2x retina (same CSS size, higher res screenshots)
ego-cli set device "iPhone 14"          # Emulate device
ego-cli set geo 37.7749 -122.4194       # Set geolocation (alias: geolocation)
ego-cli set offline on                  # Toggle offline mode
ego-cli set headers '{"X-Key":"v"}'     # Extra HTTP headers
ego-cli set credentials user pass       # HTTP basic auth (alias: auth)
ego-cli set media dark                  # Emulate color scheme
ego-cli set media light reduced-motion  # Light mode + reduced motion
```

## Cookies and Storage

```bash
ego-cli cookies                     # Get all cookies
ego-cli cookies set name value      # Set cookie
ego-cli cookies clear               # Clear cookies
ego-cli storage local               # Get all localStorage
ego-cli storage local key           # Get specific key
ego-cli storage local set k v       # Set value
ego-cli storage local clear         # Clear all
```

## Network

```bash
ego-cli network route <url>              # Intercept requests
ego-cli network route <url> --abort      # Block requests
ego-cli network route <url> --body '{}'  # Mock response
ego-cli network unroute [url]            # Remove routes
ego-cli network requests                 # View tracked requests
ego-cli network requests --filter api    # Filter requests
```

## Tabs and Windows

```bash
ego-cli tab                 # List tabs
ego-cli tab new [url]       # New tab
ego-cli tab 2               # Switch to tab by index
ego-cli tab close           # Close current tab
ego-cli tab close 2         # Close tab by index
ego-cli window new          # New window
```

## Frames

```bash
ego-cli frame "#iframe"     # Switch to iframe by CSS selector
ego-cli frame @e3           # Switch to iframe by element ref
ego-cli frame main          # Back to main frame
```

### Iframe support

Iframes are detected automatically during snapshots. When the main-frame snapshot runs, `Iframe` nodes are resolved and their content is inlined beneath the iframe element in the output (one level of nesting; iframes within iframes are not expanded).

```bash
ego-cli snapshot -i
# @e3 [Iframe] "payment-frame"
#   @e4 [input] "Card number"
#   @e5 [button] "Pay"

# Interact directly — refs inside iframes already work
ego-cli fill @e4 "4111111111111111"
ego-cli click @e5

# Or switch frame context for scoped snapshots
ego-cli frame @e3               # Switch using element ref
ego-cli snapshot -i             # Snapshot scoped to that iframe
ego-cli frame main              # Return to main frame
```

The `frame` command accepts:
- **Element refs** — `frame @e3` resolves the ref to an iframe element
- **CSS selectors** — `frame "#payment-iframe"` finds the iframe by selector
- **Frame name/URL** — matches against the browser's frame tree

## Dialogs

By default, `alert` and `beforeunload` dialogs are automatically accepted so they never block the agent. `confirm` and `prompt` dialogs still require explicit handling. Use `--no-auto-dialog` to disable this behavior.

```bash
ego-cli dialog accept [text]  # Accept dialog
ego-cli dialog dismiss        # Dismiss dialog
ego-cli dialog status         # Check if a dialog is currently open
```

## JavaScript

```bash
ego-cli eval "document.title"          # Simple expressions only
ego-cli eval -b "<base64>"             # Any JavaScript (base64 encoded)
ego-cli eval --stdin                   # Read script from stdin
```

Use `-b`/`--base64` or `--stdin` for reliable execution. Shell escaping with nested quotes and special characters is error-prone.

```bash
# Base64 encode your script, then:
ego-cli eval -b "ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW3NyYyo9Il9uZXh0Il0nKQ=="

# Or use stdin with heredoc for multiline scripts:
cat <<'EOF' | ego-cli eval --stdin
const links = document.querySelectorAll('a');
Array.from(links).map(a => a.href);
EOF
```

## State Management

```bash
ego-cli state save auth.json    # Save cookies, storage, auth state
ego-cli state load auth.json    # Restore saved state
```

## Global Options

```bash
ego-cli --session <name> ...    # Isolated browser session
ego-cli --json ...              # JSON output for parsing
ego-cli --headed ...            # Show browser window (not headless)
ego-cli --full ...              # Full page screenshot (-f)
ego-cli --cdp <port> ...        # Connect via Chrome DevTools Protocol
ego-cli -p <provider> ...       # Cloud browser provider (--provider)
ego-cli --proxy <url> ...       # Use proxy server
ego-cli --proxy-bypass <hosts>  # Hosts to bypass proxy
ego-cli --headers <json> ...    # HTTP headers scoped to URL's origin
ego-cli --executable-path <p>   # Custom browser executable
ego-cli --extension <path> ...  # Load browser extension (repeatable)
ego-cli --ignore-https-errors   # Ignore SSL certificate errors
ego-cli --help                  # Show help (-h)
ego-cli --version               # Show version (-V)
ego-cli <command> --help        # Show detailed help for a command
```

## Debugging

```bash
ego-cli --headed open example.com   # Show browser window
ego-cli --cdp 9222 snapshot         # Connect via CDP port
ego-cli connect 9222                # Alternative: connect command
ego-cli console                     # View console messages
ego-cli console --clear             # Clear console
ego-cli errors                      # View page errors
ego-cli errors --clear              # Clear errors
ego-cli highlight @e1               # Highlight element
ego-cli inspect                     # Open Chrome DevTools for this session
ego-cli trace start                 # Start recording trace
ego-cli trace stop trace.zip        # Stop and save trace
ego-cli profiler start              # Start Chrome DevTools profiling
ego-cli profiler stop trace.json    # Stop and save profile
```

## Environment Variables

```bash
AGENT_BROWSER_SESSION="mysession"            # Default session name
AGENT_BROWSER_EXECUTABLE_PATH="/path/chrome" # Custom browser path
AGENT_BROWSER_EXTENSIONS="/ext1,/ext2"       # Comma-separated extension paths
AGENT_BROWSER_PROVIDER="browserbase"         # Cloud browser provider
AGENT_BROWSER_STREAM_PORT="9223"             # Override WebSocket streaming port (default: OS-assigned)
AGENT_BROWSER_HOME="/path/to/ego-cli"  # Custom install location
```
