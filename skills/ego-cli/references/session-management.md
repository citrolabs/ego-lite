# Session Management

Multiple isolated browser sessions with state persistence and concurrent browsing.

**Related**: [authentication.md](authentication.md) for login patterns, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [Named Sessions](#named-sessions)
- [Session Isolation Properties](#session-isolation-properties)
- [Session State Persistence](#session-state-persistence)
- [Common Patterns](#common-patterns)
- [Default Session](#default-session)
- [Session Cleanup](#session-cleanup)
- [Best Practices](#best-practices)

## Named Sessions

Use `--session` flag to isolate browser contexts:

```bash
# Session 1: Authentication flow
ego-cli --session auth open https://app.example.com/login

# Session 2: Public browsing (separate cookies, storage)
ego-cli --session public open https://example.com

# Commands are isolated by session
ego-cli --session auth fill @e1 "user@example.com"
ego-cli --session public get text body
```

## Session Isolation Properties

Each session has independent:
- Cookies
- LocalStorage / SessionStorage
- IndexedDB
- Cache
- Browsing history
- Open tabs

## Session State Persistence

### Save Session State

```bash
# Save cookies, storage, and auth state
ego-cli state save /path/to/auth-state.json
```

### Load Session State

```bash
# Restore saved state
ego-cli state load /path/to/auth-state.json

# Continue with authenticated session
ego-cli open https://app.example.com/dashboard
```

### State File Contents

```json
{
  "cookies": [...],
  "localStorage": {...},
  "sessionStorage": {...},
  "origins": [...]
}
```

## Common Patterns

### Authenticated Session Reuse

```bash
#!/bin/bash
# Save login state once, reuse many times

STATE_FILE="/tmp/auth-state.json"

# Check if we have saved state
if [[ -f "$STATE_FILE" ]]; then
    ego-cli state load "$STATE_FILE"
    ego-cli open https://app.example.com/dashboard
else
    # Perform login
    ego-cli open https://app.example.com/login
    ego-cli snapshot -i
    ego-cli fill @e1 "$USERNAME"
    ego-cli fill @e2 "$PASSWORD"
    ego-cli click @e3
    ego-cli wait --load networkidle

    # Save for future use
    ego-cli state save "$STATE_FILE"
fi
```

### Concurrent Scraping

```bash
#!/bin/bash
# Scrape multiple sites concurrently

# Start all sessions
ego-cli --session site1 open https://site1.com &
ego-cli --session site2 open https://site2.com &
ego-cli --session site3 open https://site3.com &
wait

# Extract from each
ego-cli --session site1 get text body > site1.txt
ego-cli --session site2 get text body > site2.txt
ego-cli --session site3 get text body > site3.txt

# Cleanup
ego-cli --session site1 close
ego-cli --session site2 close
ego-cli --session site3 close
```

### A/B Testing Sessions

```bash
# Test different user experiences
ego-cli --session variant-a open "https://app.com?variant=a"
ego-cli --session variant-b open "https://app.com?variant=b"

# Compare
ego-cli --session variant-a screenshot /tmp/variant-a.png
ego-cli --session variant-b screenshot /tmp/variant-b.png
```

## Default Session

When `--session` is omitted, commands use the default session:

```bash
# These use the same default session
ego-cli open https://example.com
ego-cli snapshot -i
ego-cli close  # Closes default session
```

## Session Cleanup

```bash
# Close specific session
ego-cli --session auth close

# List active sessions
ego-cli session list
```

## Best Practices

### 1. Name Sessions Semantically

```bash
# GOOD: Clear purpose
ego-cli --session github-auth open https://github.com
ego-cli --session docs-scrape open https://docs.example.com

# AVOID: Generic names
ego-cli --session s1 open https://github.com
```

### 2. Always Clean Up

```bash
# Close sessions when done
ego-cli --session auth close
ego-cli --session scrape close
```

### 3. Handle State Files Securely

```bash
# Don't commit state files (contain auth tokens!)
echo "*.auth-state.json" >> .gitignore

# Delete after use
rm /tmp/auth-state.json
```

### 4. Timeout Long Sessions

```bash
# Set timeout for automated scripts
timeout 60 ego-cli --session long-task get text body
```
