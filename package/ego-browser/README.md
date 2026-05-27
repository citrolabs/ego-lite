# ego-browser

A thin helper layer for the browser-provided `ego` runtime.

```text
browser ego runtime -> helper functions -> agent scripts
```

## Usage

```bash
npm test

node artifacts/ego-browser/index.js <<'JS'
await newTab("https://example.com")
await waitForLoad()
cliLog(await pageInfo())
JS
```

To install the command onto your PATH from this checkout:

```bash
npm link

ego-browser <<'JS'
await newTab("https://example.com")
await waitForLoad()
cliLog(await pageInfo())
JS
```

The CLI executes JavaScript from stdin inside an async function. Core helpers are pre-imported into the script scope using camelCase names.

## Skill Workspace

The code package does not own mutable agent experience. By default, ego-browser loads agent helpers and learned site skills from the repository skill package:

```text
../../skills/ego-browser
```

Override this location with:

```bash
EGO_BROWSER_AGENT_WORKSPACE=/path/to/ego-browser ego-browser <<'JS'
cliLog(await siteSkills())
JS
```

Learned site skills are always active. They live under `agentWorkspace()/learnings` and are read on every helper call. Inspect what is available:

```bash
ego-browser <<'JS'
await newTab("https://example.com")
await waitForLoad()
cliLog(await siteSkills())
JS
```

Validate maintained learnings with:

```bash
npm run validate:learnings
```

## Design Notes

- The browser runtime owns tabs, task spaces, CDP transport, snapshots, and event delivery.
- This package keeps only agent-facing helper ergonomics.
- Snapshot helpers use the browser runtime contract: `ego.snapshot({ scope, includeActionMarks, includeStableLocator })`.
- `EGO_BROWSER_AGENT_WORKSPACE` overrides the default sibling skill root.
- Site-specific reusable experience belongs in the skill `learnings/` directory and is always active.

## Core Files

- `src/browser-runtime.js` - browser `ego` runtime bridge.
- `src/helpers.js` - browser helpers exposed to user scripts.
- `src/run.js` - CLI entry point and stdin execution.
- `src/learning/` - learning index, domain existence checks, and accumulated learning format validation.
