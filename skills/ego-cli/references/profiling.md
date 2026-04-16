# Profiling

Capture Chrome DevTools performance profiles during browser automation for performance analysis.

**Related**: [commands.md](commands.md) for full command reference, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [Basic Profiling](#basic-profiling)
- [Profiler Commands](#profiler-commands)
- [Categories](#categories)
- [Use Cases](#use-cases)
- [Output Format](#output-format)
- [Viewing Profiles](#viewing-profiles)
- [Limitations](#limitations)

## Basic Profiling

```bash
# Start profiling
ego-cli profiler start

# Perform actions
ego-cli navigate https://example.com
ego-cli click "#button"
ego-cli wait 1000

# Stop and save
ego-cli profiler stop ./trace.json
```

## Profiler Commands

```bash
# Start profiling with default categories
ego-cli profiler start

# Start with custom trace categories
ego-cli profiler start --categories "devtools.timeline,v8.execute,blink.user_timing"

# Stop profiling and save to file
ego-cli profiler stop ./trace.json
```

## Categories

The `--categories` flag accepts a comma-separated list of Chrome trace categories. Default categories include:

- `devtools.timeline` -- standard DevTools performance traces
- `v8.execute` -- time spent running JavaScript
- `blink` -- renderer events
- `blink.user_timing` -- `performance.mark()` / `performance.measure()` calls
- `latencyInfo` -- input-to-latency tracking
- `renderer.scheduler` -- task scheduling and execution
- `toplevel` -- broad-spectrum basic events

Several `disabled-by-default-*` categories are also included for detailed timeline, call stack, and V8 CPU profiling data.

## Use Cases

### Diagnosing Slow Page Loads

```bash
ego-cli profiler start
ego-cli navigate https://app.example.com
ego-cli wait --load networkidle
ego-cli profiler stop ./page-load-profile.json
```

### Profiling User Interactions

```bash
ego-cli navigate https://app.example.com
ego-cli profiler start
ego-cli click "#submit"
ego-cli wait 2000
ego-cli profiler stop ./interaction-profile.json
```

### CI Performance Regression Checks

```bash
#!/bin/bash
ego-cli profiler start
ego-cli navigate https://app.example.com
ego-cli wait --load networkidle
ego-cli profiler stop "./profiles/build-${BUILD_ID}.json"
```

## Output Format

The output is a JSON file in Chrome Trace Event format:

```json
{
  "traceEvents": [
    { "cat": "devtools.timeline", "name": "RunTask", "ph": "X", "ts": 12345, "dur": 100, ... },
    ...
  ],
  "metadata": {
    "clock-domain": "LINUX_CLOCK_MONOTONIC"
  }
}
```

The `metadata.clock-domain` field is set based on the host platform (Linux or macOS). On Windows it is omitted.

## Viewing Profiles

Load the output JSON file in any of these tools:

- **Chrome DevTools**: Performance panel > Load profile (Ctrl+Shift+I > Performance)
- **Perfetto UI**: https://ui.perfetto.dev/ -- drag and drop the JSON file
- **Trace Viewer**: `chrome://tracing` in any Chromium browser

## Limitations

- Only works with Chromium-based browsers (Chrome, Edge). Not supported on Firefox or WebKit.
- Trace data accumulates in memory while profiling is active (capped at 5 million events). Stop profiling promptly after the area of interest.
- Data collection on stop has a 30-second timeout. If the browser is unresponsive, the stop command may fail.
