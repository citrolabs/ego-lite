# Authentication Patterns

Login flows, task-scoped state persistence, OAuth, 2FA, and authenticated browsing.

**Related**: [task-management.md](task-management.md) for task routing and state persistence, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [Import Auth from Your Browser](#import-auth-from-your-browser)
- [Persistent Profiles](#persistent-profiles)
- [Task-Scoped State Persistence](#task-scoped-state-persistence)
- [Basic Login Flow](#basic-login-flow)
- [Saving Authentication State](#saving-authentication-state)
- [Restoring Authentication](#restoring-authentication)
- [OAuth / SSO Flows](#oauth--sso-flows)
- [Two-Factor Authentication](#two-factor-authentication)
- [HTTP Basic Auth](#http-basic-auth)
- [Cookie-Based Auth](#cookie-based-auth)
- [Token Refresh Handling](#token-refresh-handling)
- [Security Best Practices](#security-best-practices)

## Import Auth from Your Browser

The fastest way to authenticate is to reuse cookies from a Chrome session you are already logged into.

**Step 1: Start Chrome with remote debugging**

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Log in to your target site(s) in this Chrome window as you normally would.

> **Security note:** `--remote-debugging-port` exposes full browser control on localhost. Any local process can connect and read cookies, execute JS, etc. Only use on trusted machines and close Chrome when done.

**Step 2: Grab the auth state**

```bash
# Auto-discover the running Chrome and save its cookies + localStorage
ego-cli --auto-connect state save ./my-auth.json
```

**Step 3: Reuse in automation**

```bash
# Load auth at launch
ego-cli --state ./my-auth.json open https://app.example.com/dashboard

# Or load into the current task
ego-cli state load ./my-auth.json
ego-cli open https://app.example.com/dashboard
```

This works for any site, including those with complex OAuth flows, SSO, or 2FA -- as long as Chrome already has valid session cookies.

> **Security note:** State files contain session tokens in plaintext. Add them to `.gitignore`, delete when no longer needed, and set `AGENT_BROWSER_ENCRYPTION_KEY` for encryption at rest. See [Security Best Practices](#security-best-practices).

**Tip:** If you are working in a non-default Ego task, keep passing the same
`--task-id` so the loaded auth stays attached to that task:

```bash
ego-cli --task-id=s1 state load ./my-auth.json
ego-cli --task-id=s1 open https://app.example.com/dashboard
```

## Persistent Profiles

Use `--profile` to point ego-cli at a Chrome user data directory. This persists everything (cookies, IndexedDB, service workers, cache) across browser restarts without explicit save/load:

```bash
# First run: login once
ego-cli --profile ~/.myapp-profile open https://app.example.com/login
# ... complete login flow ...

# All subsequent runs: already authenticated
ego-cli --profile ~/.myapp-profile open https://app.example.com/dashboard
```

Use different paths for different projects or test users:

```bash
ego-cli --profile ~/.profiles/admin open https://app.example.com
ego-cli --profile ~/.profiles/viewer open https://app.example.com
```

Or set via environment variable:

```bash
export AGENT_BROWSER_PROFILE=~/.myapp-profile
ego-cli open https://app.example.com/dashboard
```

## Task-Scoped State Persistence

ego-cli does not require named sessions for auth reuse. The reliable pattern
is to save state from the task you are working in, then load that state back
into the task you want to resume:

```bash
ego-cli --task-id=s1 state save ./auth-state.json
ego-cli --task-id=s1 state load ./auth-state.json
```

For long-lived local workflows, a persistent Chrome profile is often simpler:

```bash
ego-cli --profile ~/.myapp-profile open https://app.example.com/dashboard
```

## Basic Login Flow

```bash
# Navigate to login page
ego-cli open https://app.example.com/login
ego-cli wait --load networkidle

# Get form elements
ego-cli snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Sign In"

# Fill credentials
ego-cli fill @e1 "user@example.com"
ego-cli fill @e2 "password123"

# Submit
ego-cli click @e3
ego-cli wait --load networkidle

# Verify login succeeded
ego-cli get url  # Should be dashboard, not login
```

## Saving Authentication State

After logging in, save state for reuse:

```bash
# Login first (see above)
ego-cli open https://app.example.com/login
ego-cli snapshot -i
ego-cli fill @e1 "user@example.com"
ego-cli fill @e2 "password123"
ego-cli click @e3
ego-cli wait --url "**/dashboard"

# Save authenticated state
ego-cli state save ./auth-state.json
```

## Restoring Authentication

Skip login by loading saved state:

```bash
# Load saved auth state
ego-cli state load ./auth-state.json

# Navigate directly to protected page
ego-cli open https://app.example.com/dashboard

# Verify authenticated
ego-cli snapshot -i
```

## OAuth / SSO Flows

For OAuth redirects:

```bash
# Start OAuth flow
ego-cli open https://app.example.com/auth/google

# Handle redirects automatically
ego-cli wait --url "**/accounts.google.com**"
ego-cli snapshot -i

# Fill Google credentials
ego-cli fill @e1 "user@gmail.com"
ego-cli click @e2  # Next button
ego-cli wait 2000
ego-cli snapshot -i
ego-cli fill @e3 "password"
ego-cli click @e4  # Sign in

# Wait for redirect back
ego-cli wait --url "**/app.example.com**"
ego-cli state save ./oauth-state.json
```

## Two-Factor Authentication

Handle 2FA with manual intervention:

```bash
# Login with credentials
ego-cli open https://app.example.com/login --headed  # Show browser
ego-cli snapshot -i
ego-cli fill @e1 "user@example.com"
ego-cli fill @e2 "password123"
ego-cli click @e3

# Wait for user to complete 2FA manually
echo "Complete 2FA in the browser window..."
ego-cli wait --url "**/dashboard" --timeout 120000

# Save state after 2FA
ego-cli state save ./2fa-state.json
```

## HTTP Basic Auth

For sites using HTTP Basic Authentication:

```bash
# Set credentials before navigation
ego-cli set credentials username password

# Navigate to protected resource
ego-cli open https://protected.example.com/api
```

## Cookie-Based Auth

Manually set authentication cookies:

```bash
# Set auth cookie
ego-cli cookies set session_token "abc123xyz"

# Navigate to protected page
ego-cli open https://app.example.com/dashboard
```

## Token Refresh Handling

For logins with expiring tokens:

```bash
#!/bin/bash
# Wrapper that handles token refresh

STATE_FILE="./auth-state.json"

# Try loading existing state
if [[ -f "$STATE_FILE" ]]; then
    ego-cli state load "$STATE_FILE"
    ego-cli open https://app.example.com/dashboard

    # Check if auth is still valid
    URL=$(ego-cli get url)
    if [[ "$URL" == *"/login"* ]]; then
        echo "Session expired, re-authenticating..."
        # Perform fresh login
        ego-cli snapshot -i
        ego-cli fill @e1 "$USERNAME"
        ego-cli fill @e2 "$PASSWORD"
        ego-cli click @e3
        ego-cli wait --url "**/dashboard"
        ego-cli state save "$STATE_FILE"
    fi
else
    # First-time login
    ego-cli open https://app.example.com/login
    # ... login flow ...
fi
```

## Security Best Practices

1. **Never commit state files** - They contain session tokens
   ```bash
   echo "*.auth-state.json" >> .gitignore
   ```

2. **Use environment variables for credentials**
   ```bash
   ego-cli fill @e1 "$APP_USERNAME"
   ego-cli fill @e2 "$APP_PASSWORD"
   ```

3. **Clean up after automation**
   ```bash
   ego-cli cookies clear
   rm -f ./auth-state.json
   ```

4. **Use short-lived task runs for CI/CD**
   ```bash
   # Don't persist state in CI
   ego-cli open https://app.example.com/login
   # ... login and perform actions ...
   ego-cli close  # Browser closes, nothing persisted unless you save state
   ```
