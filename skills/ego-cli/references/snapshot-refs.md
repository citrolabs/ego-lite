# Snapshot and Refs

Compact element references that reduce context usage dramatically for AI agents.

**Related**: [commands.md](commands.md) for full command reference, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [How Refs Work](#how-refs-work)
- [Snapshot Command](#the-snapshot-command)
- [Using Refs](#using-refs)
- [Ref Lifecycle](#ref-lifecycle)
- [Best Practices](#best-practices)
- [Ref Notation Details](#ref-notation-details)
- [Troubleshooting](#troubleshooting)

## How Refs Work

Traditional approach:
```
Full DOM/HTML → AI parses → CSS selector → Action (~3000-5000 tokens)
```

ego-cli approach:
```
Compact snapshot → @refs assigned → Direct interaction (~200-400 tokens)
```

## The Snapshot Command

```bash
# Basic snapshot (shows page structure)
ego-cli snapshot

# Interactive snapshot (-i flag) - RECOMMENDED
ego-cli snapshot -i
```

### Snapshot Output Format

```
Page: Example Site - Home
URL: https://example.com

@e1 [header]
  @e2 [nav]
    @e3 [a] "Home"
    @e4 [a] "Products"
    @e5 [a] "About"
  @e6 [button] "Sign In"

@e7 [main]
  @e8 [h1] "Welcome"
  @e9 [form]
    @e10 [input type="email"] placeholder="Email"
    @e11 [input type="password"] placeholder="Password"
    @e12 [button type="submit"] "Log In"

@e13 [footer]
  @e14 [a] "Privacy Policy"
```

## Using Refs

Once you have refs, interact directly:

```bash
# Click the "Sign In" button
ego-cli click @e6

# Fill email input
ego-cli fill @e10 "user@example.com"

# Fill password
ego-cli fill @e11 "password123"

# Submit the form
ego-cli click @e12
```

## Ref Lifecycle

**IMPORTANT**: Refs are invalidated when the page changes!

```bash
# Get initial snapshot
ego-cli snapshot -i
# @e1 [button] "Next"

# Click triggers page change
ego-cli click @e1

# MUST re-snapshot to get new refs!
ego-cli snapshot -i
# @e1 [h1] "Page 2"  ← Different element now!
```

## Best Practices

### 1. Always Snapshot Before Interacting

```bash
# CORRECT
ego-cli open https://example.com
ego-cli snapshot -i          # Get refs first
ego-cli click @e1            # Use ref

# WRONG
ego-cli open https://example.com
ego-cli click @e1            # Ref doesn't exist yet!
```

### 2. Re-Snapshot After Navigation

```bash
ego-cli click @e5            # Navigates to new page
ego-cli snapshot -i          # Get new refs
ego-cli click @e1            # Use new refs
```

### 3. Re-Snapshot After Dynamic Changes

```bash
ego-cli click @e1            # Opens dropdown
ego-cli snapshot -i          # See dropdown items
ego-cli click @e7            # Select item
```

### 4. Snapshot Specific Regions

For complex pages, snapshot specific areas:

```bash
# Snapshot just the form
ego-cli snapshot @e9
```

## Ref Notation Details

```
@e1 [tag type="value"] "text content" placeholder="hint"
│    │   │             │               │
│    │   │             │               └─ Additional attributes
│    │   │             └─ Visible text
│    │   └─ Key attributes shown
│    └─ HTML tag name
└─ Unique ref ID
```

### Common Patterns

```
@e1 [button] "Submit"                    # Button with text
@e2 [input type="email"]                 # Email input
@e3 [input type="password"]              # Password input
@e4 [a href="/page"] "Link Text"         # Anchor link
@e5 [select]                             # Dropdown
@e6 [textarea] placeholder="Message"     # Text area
@e7 [div class="modal"]                  # Container (when relevant)
@e8 [img alt="Logo"]                     # Image
@e9 [checkbox] checked                   # Checked checkbox
@e10 [radio] selected                    # Selected radio
```

## Iframes

Snapshots automatically detect and inline iframe content. When the main-frame snapshot runs, each `Iframe` node is resolved and its child accessibility tree is included directly beneath it in the output. Refs assigned to elements inside iframes carry frame context, so interactions like `click`, `fill`, and `type` work without manually switching frames.

```bash
ego-cli snapshot -i
# @e1 [heading] "Checkout"
# @e2 [Iframe] "payment-frame"
#   @e3 [input] "Card number"
#   @e4 [input] "Expiry"
#   @e5 [button] "Pay"
# @e6 [button] "Cancel"

# Interact with iframe elements directly using their refs
ego-cli fill @e3 "4111111111111111"
ego-cli fill @e4 "12/28"
ego-cli click @e5
```

**Key details:**
- Only one level of iframe nesting is expanded (iframes within iframes are not recursed)
- Cross-origin iframes that block accessibility tree access are silently skipped
- Empty iframes or iframes with no interactive content are omitted from the output
- To scope a snapshot to a single iframe, use `frame @ref` then `snapshot -i`

## Troubleshooting

### "Ref not found" Error

```bash
# Ref may have changed - re-snapshot
ego-cli snapshot -i
```

### Element Not Visible in Snapshot

```bash
# Scroll down to reveal element
ego-cli scroll down 1000
ego-cli snapshot -i

# Or wait for dynamic content
ego-cli wait 1000
ego-cli snapshot -i
```

### Too Many Elements

```bash
# Snapshot specific container
ego-cli snapshot @e5

# Or use get text for content-only extraction
ego-cli get text @e5
```
