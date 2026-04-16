---
name: agentcore
description: Run ego-cli on AWS Bedrock AgentCore cloud browsers. Use when the user wants to use AgentCore, run browser automation on AWS, use a cloud browser with AWS credentials, or needs a managed browser session backed by AWS infrastructure. Triggers include "use agentcore", "run on AWS", "cloud browser with AWS", "bedrock browser", "agentcore session", or any task requiring AWS-hosted browser automation.
allowed-tools: Bash(ego-cli:*), Bash(npx ego-cli:*)
---

# AWS Bedrock AgentCore

Run ego-cli on cloud browser sessions hosted by AWS Bedrock AgentCore. All standard ego-cli commands work identically; the only difference is where the browser runs.

## Setup

Credentials are resolved automatically:

1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optionally `AWS_SESSION_TOKEN`)
2. AWS CLI fallback (`aws configure export-credentials`), which supports SSO, IAM roles, and named profiles

No additional setup is needed if the user already has working AWS credentials.

## Core Workflow

```bash
# Open a page on an AgentCore cloud browser
ego-cli -p agentcore open https://example.com

# Everything else is the same as local Chrome
ego-cli snapshot -i
ego-cli click @e1
ego-cli screenshot page.png
ego-cli close
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENTCORE_REGION` | AWS region | `us-east-1` |
| `AGENTCORE_BROWSER_ID` | Browser identifier | `aws.browser.v1` |
| `AGENTCORE_PROFILE_ID` | Persistent browser profile (cookies, localStorage) | (none) |
| `AGENTCORE_SESSION_TIMEOUT` | Session timeout in seconds | `3600` |
| `AWS_PROFILE` | AWS CLI profile for credential resolution | `default` |

## Persistent Profiles

Use `AGENTCORE_PROFILE_ID` to persist browser state across sessions. This is useful for maintaining login sessions:

```bash
# First run: log in
AGENTCORE_PROFILE_ID=my-app ego-cli -p agentcore open https://app.example.com/login
ego-cli snapshot -i
ego-cli fill @e1 "user@example.com"
ego-cli fill @e2 "password"
ego-cli click @e3
ego-cli close

# Future runs: already authenticated
AGENTCORE_PROFILE_ID=my-app ego-cli -p agentcore open https://app.example.com/dashboard
```

## Live View

When a session starts, AgentCore prints a Live View URL to stderr. Open it in a browser to watch the session in real time from the AWS Console:

```
Session: abc123-def456
Live View: https://us-east-1.console.aws.amazon.com/bedrock-agentcore/browser/aws.browser.v1/session/abc123-def456#
```

## Region Selection

```bash
# Default: us-east-1
ego-cli -p agentcore open https://example.com

# Explicit region
AGENTCORE_REGION=eu-west-1 ego-cli -p agentcore open https://example.com
```

## Credential Patterns

```bash
# Explicit credentials (CI/CD, scripts)
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
ego-cli -p agentcore open https://example.com

# SSO (interactive)
aws sso login --profile my-profile
AWS_PROFILE=my-profile ego-cli -p agentcore open https://example.com

# IAM role / default credential chain
ego-cli -p agentcore open https://example.com
```

## Using with AGENT_BROWSER_PROVIDER

Set the provider via environment variable to avoid passing `-p agentcore` on every command:

```bash
export AGENT_BROWSER_PROVIDER=agentcore
export AGENTCORE_REGION=us-east-2

ego-cli open https://example.com
ego-cli snapshot -i
ego-cli click @e1
ego-cli close
```

## Common Issues

**"Failed to run aws CLI"** means AWS CLI is not installed or not in PATH. Either install it or set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` directly.

**"AWS CLI failed: ... Run 'aws sso login'"** means SSO credentials have expired. Run `aws sso login` to refresh them.

**Session timeout:** The default is 3600 seconds (1 hour). For longer tasks, increase with `AGENTCORE_SESSION_TIMEOUT=7200`.
