# ego-browser (Node helper runtime)

The Node.js helper layer that runs inside the `ego-browser` Chromium browser. The browser exposes an `ego` runtime (tabs, CDP, snapshots, task spaces); this package bundles the agent-facing helpers that script that runtime.

```text
ego-browser (Chromium) → globalThis.ego → helper functions → agent heredoc
```

## Build and run

```bash
npm ci
npm run build     # bundle to dist/out/index.js
npm test          # build + tsc --noEmit + node --test
```

The build emits a single ESM file `dist/out/index.js`. The ego-browser browser dispatches `ego-browser nodejs <<'EOF' ... EOF` heredocs to that bundle. The v2 `TaskSpace` and `Page` APIs are preloaded; the v1 global helpers remain available only for existing scripts.

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace('demo')
const page = task.page('p1')
await page.goto('https://example.com')
console.log(await page.snapshot())
EOF
```

Local invocation without the browser (for debugging the helper bundle itself) reads stdin:

```bash
node dist/out/index.js <<'JS'
console.log(await help())
JS
```

Use `-h` or `--help` to print the local CLI usage.

## Skill workspace

By default the runtime loads agent helpers and site learnings from the guide bundled next to the SDK (`dist/out/ego-browser`), built from:

```text
skill/
```

Override with `EGO_BROWSER_AGENT_WORKSPACE`:

```bash
EGO_BROWSER_AGENT_WORKSPACE=/path/to/skill ego-browser nodejs <<'EOF'
cliLog(await siteSkills())
EOF
```

Site learnings under `agentWorkspace()/learnings/<site>/` are always active and read on every helper call. Validate them with:

```bash
npm run validate:site-skills
```

## Source layout

```
src/
  run.ts                 CLI entry; reads stdin, injects helpers, executes
  helpers.ts             public helper surface (re-exports + glue)
  page-model.ts          TaskSpace/Page lifecycle and operations
  public-api-schema.ts   v2 validation, help, and reference source
  browser-runtime.ts     bridge to globalThis.ego (CDP, sessions, events)
  element-resolver.ts    resolves @N / CSS / XPath / ARIA targets
  driver/
    pointer.ts           click, hover, drag, scroll, scrollBy
    observe.ts           snapshot, captureScreenshot, elementCenter
    keyboard.ts          typeText, pressKey, fillInput, dispatchKey
    nav.ts               tabs, gotoUrl, openOrReuseTab, closeTab
    load.ts              waitForLoad and load orchestration
    waits.ts             waitForElement, waitForNetworkIdle, wait
    files.ts             uploadFile
  http.ts                serverFetch, browserFetch
  cdp-eval.ts            cdp() and js() raw eval
  learning/              site-learnings discovery and manifest validation
scripts/
  build.mjs              esbuild bundling
```

See `skill/GUIDE.md` for the agent-facing workflow (printed by `ego-browser skill`)
and `../../docs/api-reference.md` for the generated v2 API reference.
The old global helpers remain available as a v1 compatibility surface for
existing scripts.

## Design constraints

- The browser runtime owns tabs, task spaces, CDP transport, snapshots, and event delivery. This package keeps only agent-facing ergonomics.
- Snapshot helpers use the browser runtime contract: `ego.snapshot({ scope, root, includeActionMarks, includeStableLocator })`; the Page API resolves a subtree `root` from a Page-scoped snapshot ref before invoking it.
- V2 Page refs are SDK-assigned ids bound to a frame, document, and backend node. Input actions preserve refs to unchanged nodes, allowing consecutive ref actions. Partial snapshots retain omitted refs; full-page snapshots replace the active set. The Page ledger persists mappings and invalidation across Agent rounds. Missing, stale, or unresolvable refs require a fresh snapshot rather than native renumbering or role/name fallback.
- Page selectors search the top document first. Input actions search frames
  when the top document has no match usable for that action, then require one
  usable frame match.
- The selector parser supports the documented Ego forms plus a narrow
  Playwright-compatible subset: `css=`, terminal `:has-text()`, `:text-is()`,
  `>> nth=N` after CSS/text/href selectors (`N >= 0` or `-1`), and role
  `name*=` matching.
- Clicks require an enabled element and a real hit target. Hover and drag keep
  the hit-target requirement but may address disabled elements. DOM-backed
  actions such as `selectOption()` require a rendered, enabled control but may
  operate on an opacity-zero native control used by a custom widget. Like
  Playwright, `selectOption()` can programmatically choose a disabled option.
- Network-idle waits use continuous per-Page and OOPIF request state; they do
  not consume the CDP events returned by `page.events()` or include other Pages.
- `fill()` verifies that editing took effect, not that application formatting
  preserved the requested string byte-for-byte. Business postconditions remain
  explicit Page reads or waits.
- New public APIs must be added to `public-api-schema.ts`; runtime validation,
  default `help()`, the generated reference, and the usage guide must remain aligned.
- Embedded hosts should await the exported `disposeEgoSdk()` hook before
  discarding a Node context; see `../../docs/native-sdk-lifecycle-requirement.md`.
- Site-specific reusable experience belongs under `skill/learnings/`, not in the runtime source.

## License

MIT
