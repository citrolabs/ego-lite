# ego-browser (Node helper runtime)

The Node.js helper layer that runs inside the `ego-browser` Chromium browser. The browser exposes an `ego` runtime (tabs, CDP, snapshots, task spaces); this package bundles the agent-facing helpers that script that runtime.

```text
ego-browser (Chromium) → globalThis.ego → helper functions → agent heredoc
```

## Build and run

```bash
npm ci
npm run build     # bundle to artifacts/ego-browser/index.js
npm test          # build + tsc --noEmit + node --test
```

The build emits a single ESM file `artifacts/ego-browser/index.js`. The ego-browser browser dispatches `ego-browser nodejs <<'EOF' ... EOF` heredocs to that bundle. Inside the heredoc, all helpers (`snapshotText`, `click`, `useOrCreateTaskSpace`, ...) are pre-imported in camelCase.

```bash
ego-browser nodejs <<'EOF'
await useOrCreateTaskSpace('demo')
await openOrReuseTab('https://example.com', { wait: true })
cliLog(await snapshotText())
EOF
```

Local invocation without the browser (for debugging the helper bundle itself) reads stdin:

```bash
node artifacts/ego-browser/index.js <<'JS'
cliLog(await pageInfo())
JS
```

Flags: `-h | --help`, `--doctor`, `--reload`, `--debug-clicks`.

## Skill workspace

By default the runtime loads agent helpers and site learnings from the sibling skill package:

```text
../../skills/ego-browser
```

Override with `EGO_BROWSER_AGENT_WORKSPACE`:

```bash
EGO_BROWSER_AGENT_WORKSPACE=/path/to/skill ego-browser nodejs <<'EOF'
cliLog(await siteSkills())
EOF
```

Site learnings under `agentWorkspace()/learnings/<site>/` are always active and read on every helper call. Validate them with:

```bash
npm run validate:site-skills    # alias: validate:learnings
```

## Source layout

```
src/
  run.ts                 CLI entry; reads stdin, injects helpers, executes
  helpers.ts             public helper surface (re-exports + glue)
  browser-runtime.ts     bridge to globalThis.ego (CDP, sessions, events)
  element-resolver.ts    resolves @eN / CSS / XPath / ARIA targets
  driver/
    pointer.ts           click, hover, drag, scroll, scrollBy
    observe.ts           snapshot, captureScreenshot, elementEval
    keyboard.ts          typeText, pressKey, fillInput, dispatchKey
    nav.ts               tabs, gotoUrl, openOrReuseTab
    load.ts              waitForLoad and load orchestration
    waits.ts             waitForElement, waitForNetworkIdle, wait
    files.ts             uploadFile
  http.ts                serverFetch, browserFetch
  cdp-eval.ts            cdp() and js() raw eval
  learning/              site-learnings discovery and manifest validation
scripts/
  build.mjs              esbuild bundling
```

The top-level repo README has the full helper inventory and the task-space / control-handoff protocol. See also `../../skills/ego-browser/SKILL.md` for the agent-facing contract.

## Design constraints

- The browser runtime owns tabs, task spaces, CDP transport, snapshots, and event delivery. This package keeps only agent-facing ergonomics.
- Snapshot helpers use the browser runtime contract: `ego.snapshot({ scope, includeActionMarks, includeStableLocator })`.
- Public helpers are camelCase only.
- Site-specific reusable experience belongs under `skills/ego-browser/learnings/`, not in this package.

## License

MIT
