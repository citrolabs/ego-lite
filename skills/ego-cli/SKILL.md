---
name: ego-cli
description: Core ego-cli usage guide. Read this before running any ego-cli commands. Covers the snapshot-and-ref workflow, navigating pages, interacting with elements (click, fill, type, select), extracting text and data, taking screenshots, managing tabs, handling forms and auth, waiting for content, routing commands to service-managed tasks, and troubleshooting common failures. Use when the user asks to interact with a website, fill a form, click something, extract data, take a screenshot, log into a site, test a web app, or automate any browser task.
allowed-tools: Bash(ego-cli:*), Bash(npx ego-cli:*)
---

# ego-cli core

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP, no
Playwright or Puppeteer dependency. Accessibility-tree snapshots with compact
`@eN` refs let agents interact with pages in ~200-400 tokens instead of
parsing raw HTML.

Most normal web tasks (navigate, read, click, fill, extract, screenshot) are covered here.

## The core loop

```bash
ego-cli open <url>        # 1. Open a page
ego-cli snapshot -i       # 2. See what's on it (interactive elements only)
ego-cli click @e3         # 3. Act on refs from the snapshot
ego-cli snapshot -i       # 4. Re-snapshot after any page change
```

Refs (`@e1`, `@e2`, ...) are assigned fresh on every snapshot. They become
**stale the moment the page changes** — after clicks that navigate, form
submits, dynamic re-renders, dialog opens. Always re-snapshot before your
next ref interaction.

## Quickstart

```bash
# Install once
npm i -g ego-cli && ego-cli install

# Take a screenshot of a page
ego-cli open https://example.com
ego-cli screenshot home.png
ego-cli close

# Search, click a result, and capture it
ego-cli open https://duckduckgo.com
ego-cli snapshot -i                      # find the search box ref
ego-cli fill @e1 "ego-cli cli"
ego-cli press Enter
ego-cli wait --load networkidle
ego-cli snapshot -i                      # refs now reflect results
ego-cli click @e5                        # click a result
ego-cli screenshot result.png
```

The browser stays running across commands so these feel like a single
workflow. When `--task-id` is omitted, commands run inside the implicit
`default` task. Use `ego-cli close` when you're done with the current task's
browser.

## Reading a page

```bash
ego-cli snapshot                    # full tree (verbose)
ego-cli snapshot -i                 # interactive elements only (preferred)
ego-cli snapshot -i -u              # include href urls on links
ego-cli snapshot -i -c              # compact (no empty structural nodes)
ego-cli snapshot -i -d 3            # cap depth at 3 levels
ego-cli snapshot -s "#main"         # scope to a CSS selector
ego-cli snapshot -i --json          # machine-readable output
```

Snapshot output looks like:

```
Page: Example - Log in
URL: https://example.com/login

@e1 [heading] "Log in"
@e2 [form]
  @e3 [input type="email"] placeholder="Email"
  @e4 [input type="password"] placeholder="Password"
  @e5 [button type="submit"] "Continue"
  @e6 [link] "Forgot password?"
```

For unstructured reading (no refs needed):

```bash
ego-cli get text @e1                # visible text of an element
ego-cli get html @e1                # innerHTML
ego-cli get attr @e1 href           # any attribute
ego-cli get value @e1               # input value
ego-cli get title                   # page title
ego-cli get url                     # current URL
ego-cli get count ".item"           # count matching elements
```

## Interacting

```bash
ego-cli click @e1                   # click
ego-cli click @e1 --new-tab         # open link in new tab instead of navigating
ego-cli dblclick @e1                # double-click
ego-cli hover @e1                   # hover
ego-cli focus @e1                   # focus (useful before keyboard input)
ego-cli fill @e2 "hello"            # clear then type
ego-cli type @e2 " world"           # type without clearing
ego-cli press Enter                 # press a key at current focus
ego-cli press Control+a             # key combination
ego-cli check @e3                   # check checkbox
ego-cli uncheck @e3                 # uncheck
ego-cli select @e4 "option-value"   # select dropdown option
ego-cli select @e4 "a" "b"          # select multiple
ego-cli upload @e5 file1.pdf        # upload file(s)
ego-cli scroll down 500             # scroll page (up/down/left/right)
ego-cli scrollintoview @e1          # scroll element into view
ego-cli drag @e1 @e2                # drag and drop
```

### When refs don't work or you don't want to snapshot

Use semantic locators:

```bash
ego-cli find role button click --name "Submit"
ego-cli find text "Sign In" click
ego-cli find text "Sign In" click --exact     # exact match only
ego-cli find label "Email" fill "user@test.com"
ego-cli find placeholder "Search" type "query"
ego-cli find testid "submit-btn" click
ego-cli find first ".card" click
ego-cli find nth 2 ".card" hover
```

Or a raw CSS selector:

```bash
ego-cli click "#submit"
ego-cli fill "input[name=email]" "user@test.com"
ego-cli click "button.primary"
```

Rule of thumb: snapshot + `@eN` refs are fastest and most reliable for
AI agents. `find role/text/label` is next best and doesn't require a prior
snapshot. Raw CSS is a fallback when the others fail.

## Waiting (read this)

Agents fail more often from bad waits than from bad selectors. Pick the
right wait for the situation:

```bash
ego-cli wait @e1                     # until an element appears
ego-cli wait 2000                    # dumb wait, milliseconds (last resort)
ego-cli wait --text "Success"        # until the text appears on the page
ego-cli wait --url "**/dashboard"    # until URL matches pattern (glob)
ego-cli wait --load networkidle      # until network idle (post-navigation)
ego-cli wait --load domcontentloaded # until DOMContentLoaded
ego-cli wait --fn "window.myApp.ready === true"  # until JS condition
```

After any page-changing action, pick one:

- Wait for a specific element you expect to appear: `wait @ref` or `wait --text "..."`.
- Wait for URL change: `wait --url "**/new-page"`.
- Wait for network idle (catch-all for SPA navigation): `wait --load networkidle`.

Avoid bare `wait 2000` except when debugging — it makes scripts slow and
flaky. Timeouts default to 25 seconds.

## Common workflows

### Log in

```bash
ego-cli open https://app.example.com/login
ego-cli snapshot -i

# Pick the email/password refs out of the snapshot, then:
ego-cli fill @e3 "user@example.com"
ego-cli fill @e4 "hunter2"
ego-cli click @e5
ego-cli wait --url "**/dashboard"
ego-cli snapshot -i
```

Credentials in shell history are a leak. For anything sensitive, use the
auth vault (see [reference/authentication.md](reference/authentication.md)):

```bash
ego-cli auth save my-app --url https://app.example.com/login \
  --username user@example.com --password-stdin
# (type password, Ctrl+D)

ego-cli auth login my-app    # fills + clicks, waits for form
```

### Persist auth state across runs

```bash
# Log in once, save cookies + localStorage
ego-cli state save ./auth.json

# Later runs start already logged in
ego-cli --state ./auth.json open https://app.example.com
```

### Extract data

```bash
# Structured snapshot (best for AI reasoning over page content)
ego-cli snapshot -i --json > page.json

# Targeted extraction with refs
ego-cli snapshot -i
ego-cli get text @e5
ego-cli get attr @e10 href

# Arbitrary shape via JavaScript
cat <<'EOF' | ego-cli eval --stdin
const rows = document.querySelectorAll("table tbody tr");
Array.from(rows).map(r => ({
  name: r.cells[0].innerText,
  price: r.cells[1].innerText,
}));
EOF
```

Prefer `eval --stdin` (heredoc) or `eval -b <base64>` for any JS with
quotes or special characters. Inline `ego-cli eval "..."` works
only for simple expressions.

### Screenshot

```bash
ego-cli screenshot                        # temp path, printed on stdout
ego-cli screenshot page.png               # specific path
ego-cli screenshot --full full.png        # full scroll height
ego-cli screenshot --annotate map.png     # numbered labels + legend keyed to snapshot refs
```

`--annotate` is designed for multimodal models: each label `[N]` maps to ref `@eN`.

### Handle multiple pages via tabs

```bash
ego-cli tab                      # list open tabs (with stable tabId)
ego-cli tab new https://docs...  # open a new tab (and switch to it)
ego-cli tab t2                   # switch to tab t2
ego-cli tab close t2             # close tab t2
```

Stable `tabId`s mean `tab t2` points at the same tab across commands even
when other tabs open or close. After switching, refs from a prior snapshot
on a different tab no longer apply — re-snapshot.

### Work with multiple tasks

When Ego has created service-managed tasks, route commands to a specific task
with `--task-id=<task-id>`. Each task keeps its own browser state, tabs, and
refs.

```bash
ego-cli task list
ego-cli --task-id=s1 snapshot -i
ego-cli --task-id=s2 snapshot -i
ego-cli --task-id=s1 click @e3
ego-cli task complete s1
```

### Mock network requests

```bash
ego-cli network route "**/api/users" --body '{"users":[]}'   # stub a response
ego-cli network route "**/analytics" --abort                 # block entirely
ego-cli network requests                                     # inspect what fired
ego-cli network har start                                    # record all traffic
# ... perform actions ...
ego-cli network har stop /tmp/trace.har
```

### Record a video of the workflow

```bash
ego-cli record start demo.webm
ego-cli open https://example.com
ego-cli snapshot -i
ego-cli click @e3
ego-cli record stop
```

See [reference/video-recording.md](reference/video-recording.md) for
codec options, GIF export, and more.

### Iframes

Iframes are auto-inlined in the snapshot — their refs work transparently:

```bash
ego-cli snapshot -i
# @e3 [Iframe] "payment-frame"
#   @e4 [input] "Card number"
#   @e5 [button] "Pay"

ego-cli fill @e4 "4111111111111111"
ego-cli click @e5
```

To scope a snapshot to an iframe (for focus or deep nesting):

```bash
ego-cli frame @e3      # switch context to the iframe
ego-cli snapshot -i
ego-cli frame main     # back to main frame
```

### Dialogs

`alert` and `beforeunload` are auto-accepted so agents never block. For
`confirm` and `prompt`:

```bash
ego-cli dialog status          # is there a pending dialog?
ego-cli dialog accept           # accept
ego-cli dialog accept "text"    # accept with prompt input
ego-cli dialog dismiss          # cancel
```

## Diagnosing install issues

If a command fails unexpectedly (`Unknown command`, `Failed to connect`,
stale daemons, version mismatches after `upgrade`, missing Chrome, etc.),
do not use `doctor`: current `ego-cli --help` does not expose a `doctor`
command.

## Troubleshooting

**"Ref not found" / "Element not found: @eN"**
Page changed since the snapshot. Run `ego-cli snapshot -i` again,
then use the new refs.

**Element exists in the DOM but not in the snapshot**
It's probably off-screen or not yet rendered. Try:

```bash
ego-cli scroll down 1000
ego-cli snapshot -i
# or
ego-cli wait --text "..."
ego-cli snapshot -i
```

**Click does nothing / overlay swallows the click**
Some modals and cookie banners block other clicks. Snapshot, find the
dismiss/close button, click it, then re-snapshot.

**Fill / type doesn't work**
Some custom input components intercept key events. Try:

```bash
ego-cli focus @e1
ego-cli keyboard inserttext "text"    # bypasses key events
# or
ego-cli keyboard type "text"          # raw keystrokes, no selector
```

**Page needs JS you can't get right in one shot**
Use `eval --stdin` with a heredoc instead of inline:

```bash
cat <<'EOF' | ego-cli eval --stdin
// Complex script with quotes, backticks, whatever
document.querySelectorAll('[data-id]').length
EOF
```

**Cross-origin iframe not accessible**
Cross-origin iframes that block accessibility tree access are silently
skipped. Use `frame "#iframe"` to switch into them explicitly if the
parent opts in, otherwise the iframe's contents aren't available via
snapshot — fall back to `eval` in the iframe's origin or use the
`--headers` flag to satisfy CORS.

**Authentication expires mid-workflow**
Use `state save`/`state load` or a persistent `--profile` so auth survives
browser restarts. If you're working in a non-default Ego task, keep passing
the same `--task-id` so the restored auth stays attached to that task. See
[reference/task-management.md](reference/task-management.md) and
[reference/authentication.md](reference/authentication.md).

## Common flags worth knowing

```bash
--task-id=<task-id>     # route a command to a specific Ego task
--server-name=<name>    # connect to a specific Ego CLI server endpoint
--json                  # JSON output (for machine parsing)
--headed                # show the window (default is headless)
--auto-connect          # connect to an already-running Chrome
--cdp <port>            # connect to a specific CDP port
--profile <name|path>   # use a Chrome profile (login state survives)
--headers <json>        # HTTP headers scoped to the URL's origin
--proxy <url>           # proxy server
--state <path>          # load saved auth state from JSON
```

## Full reference

Use this document plus the local reference files directly:

- `reference/commands.md` — every command, flag, alias
- `reference/snapshot-refs.md` — deep dive on the snapshot + ref model
- `reference/authentication.md` — auth vault, credential handling
- `reference/task-management.md` — task routing and task-scoped workflows
- `reference/profiling.md` — Chrome DevTools tracing and profiling
- `reference/video-recording.md` — video capture options
- `reference/proxy-support.md` — proxy configuration
- `templates/*` — starter shell scripts for auth, capture, form automation
