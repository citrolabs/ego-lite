# Video Recording

Capture browser automation as video for debugging, documentation, or verification.

**Related**: [commands.md](commands.md) for full command reference, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [Basic Recording](#basic-recording)
- [Recording Commands](#recording-commands)
- [Use Cases](#use-cases)
- [Best Practices](#best-practices)
- [Output Format](#output-format)
- [Limitations](#limitations)

## Basic Recording

```bash
# Start recording
ego-cli record start ./demo.webm

# Perform actions
ego-cli open https://example.com
ego-cli snapshot -i
ego-cli click @e1
ego-cli fill @e2 "test input"

# Stop and save
ego-cli record stop
```

## Recording Commands

```bash
# Start recording to file
ego-cli record start ./output.webm

# Stop current recording
ego-cli record stop

# Restart with new file (stops current + starts new)
ego-cli record restart ./take2.webm
```

## Use Cases

### Debugging Failed Automation

```bash
#!/bin/bash
# Record automation for debugging

ego-cli record start ./debug-$(date +%Y%m%d-%H%M%S).webm

# Run your automation
ego-cli open https://app.example.com
ego-cli snapshot -i
ego-cli click @e1 || {
    echo "Click failed - check recording"
    ego-cli record stop
    exit 1
}

ego-cli record stop
```

### Documentation Generation

```bash
#!/bin/bash
# Record workflow for documentation

ego-cli record start ./docs/how-to-login.webm

ego-cli open https://app.example.com/login
ego-cli wait 1000  # Pause for visibility

ego-cli snapshot -i
ego-cli fill @e1 "demo@example.com"
ego-cli wait 500

ego-cli fill @e2 "password"
ego-cli wait 500

ego-cli click @e3
ego-cli wait --load networkidle
ego-cli wait 1000  # Show result

ego-cli record stop
```

### CI/CD Test Evidence

```bash
#!/bin/bash
# Record E2E test runs for CI artifacts

TEST_NAME="${1:-e2e-test}"
RECORDING_DIR="./test-recordings"
mkdir -p "$RECORDING_DIR"

ego-cli record start "$RECORDING_DIR/$TEST_NAME-$(date +%s).webm"

# Run test
if run_e2e_test; then
    echo "Test passed"
else
    echo "Test failed - recording saved"
fi

ego-cli record stop
```

## Best Practices

### 1. Add Pauses for Clarity

```bash
# Slow down for human viewing
ego-cli click @e1
ego-cli wait 500  # Let viewer see result
```

### 2. Use Descriptive Filenames

```bash
# Include context in filename
ego-cli record start ./recordings/login-flow-2024-01-15.webm
ego-cli record start ./recordings/checkout-test-run-42.webm
```

### 3. Handle Recording in Error Cases

```bash
#!/bin/bash
set -e

cleanup() {
    ego-cli record stop 2>/dev/null || true
    ego-cli close 2>/dev/null || true
}
trap cleanup EXIT

ego-cli record start ./automation.webm
# ... automation steps ...
```

### 4. Combine with Screenshots

```bash
# Record video AND capture key frames
ego-cli record start ./flow.webm

ego-cli open https://example.com
ego-cli screenshot ./screenshots/step1-homepage.png

ego-cli click @e1
ego-cli screenshot ./screenshots/step2-after-click.png

ego-cli record stop
```

## Output Format

- Default format: WebM (VP8/VP9 codec)
- Compatible with all modern browsers and video players
- Compressed but high quality

## Limitations

- Recording adds slight overhead to automation
- Large recordings can consume significant disk space
- Some headless environments may have codec limitations
