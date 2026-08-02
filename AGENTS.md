# Repository Guidelines

## Project Overview
`ego-browser` is a Node.js CDP browser-automation harness for AI agents. It drives the ego lite browser through `globalThis.ego` bindings (provided by the closed-source ego lite app), exposes a compact snapshot/ref workflow, and layers reusable site-specific knowledge ("learnings") on top of the browser runtime.

This repo contains the open-source harness and the agent skill package — **not** the browser itself. The ego lite app bundles its own `ego-browser` binary that embeds this runtime; `skills/ego-browser/SKILL.md` documents that binary's usage (`ego-browser nodejs <<'EOF' ... EOF`). The repo CLI built here takes the heredoc directly on stdin with no subcommand.

## Architecture & Data Flow
- `package/ego-browser/src/index.ts` is the entrypoint with two startup paths:
  - Executed directly as a CLI → `runMain()` (reads JavaScript from stdin, executes it).
  - Imported as a module (how the app embeds it) → `installEgoSdk(globalThis)`.
- Both paths expose the same built-in helper surface, built by `helperContext()` in `src/helpers.ts` — the single source of truth for the built-in facades and `help()`. The CLI additionally merges exports from `agent_helpers.js`; SDK callers can supply an extended `options.context`.
- `src/run.ts` executes stdin JavaScript inside an async function with the helpers injected as parameters.
- `src/browser-runtime.ts` owns CDP transport over `ego.sendCDPMessage`, session attach/caching (2s TTL, auto re-attach on session loss), the buffered event queue (10k cap), and JS dialog tracking.
- `src/cdp-eval.ts` provides `cdp()` and `evaluate()` (string-expression evaluation; top-level `return` is auto-wrapped in an IIFE).
- `src/element-resolver.ts` resolves `@N` refs, raw CSS, `xpath=`, `loc=css:` / `loc=href:` / semantic locators (`role`, `text`, `label`, `placeholder`, `alt`, `title`, `testid`), and internal scope/filter/nth/last selectors; failures are classified as `transient` (retryable) or `permanent`.
- `src/ref-map.ts` + `src/ref-state.ts`: refs are numeric `backendNodeId`s (`@21`, not `@e21`). Every snapshot rebuilds the map, and using a ref while the map is empty triggers an automatic snapshot; an `@N` ref is still valid only after the latest snapshot in the current invocation, so re-snapshot across heredoc rounds or use a stable locator.
- `src/driver/` — `nav` (tabs, navigation), `pointer` (click/scroll/drag), `keyboard`, `observe` (snapshot/screenshot), `waits`, `locator` (strict locator operations), `downloads`, `screencast`, `files` (upload), `element-ops` (objectId handles), `load`.
- `src/learning/` — discovery, validation, and execution of site skills from `skills/ego-browser/learnings/<site>/manifest.json` (`runSiteTool`, `runSiteBrowserTool`, `learnContext`).
- `src/state.ts` is the shared mutable runtime state singleton; `src/env.ts` resolves the agent workspace (`EGO_BROWSER_AGENT_WORKSPACE`, falling back to the skill dir bundled next to the build output, then the repo's `skills/ego-browser`).
- `src/help-runtime.ts` parses the built bundle's JSDoc with acorn at runtime to power `help()` — JSDoc on exported helpers is therefore user-facing documentation.

Data flow: `stdin JS` → `runMain()` → `helperContext()` helpers → browser runtime/CDP → snapshot or DOM/AX resolution → optional site tools → `console.log(...)`.

## Task Spaces
Task spaces are isolated browsing contexts with an ownership model (`agent` / `agentDelegatedToUser` / `user`); `agentDelegatedToUser` remains agent-owned while control is temporarily with the user:
- `taskSpaces.useOrCreate(nameOrId)` reuses an agent-owned space or creates a new one; it no longer auto-claims user-owned spaces. Use `taskSpaces.claim(nameOrId)` to take ownership of a user-owned space. Ids are numeric; prefer `task.id` over names across rounds.
- `taskSpaces.switch(nameOrId)` requires agent ownership; `taskSpaces.new(name)` creates; `taskSpaces.complete(nameOrId, { keep })` finishes (`keep` is mandatory).
- Control handoff: `taskSpaces.handOff([nameOrId])` / `taskSpaces.takeOver([nameOrId])` / `taskSpaces.waitForAgentControl(nameOrId)`.

## Key Directories
- `package/ego-browser/src/` — runtime, helpers, resolver, drivers, learning subsystem.
- Tests live both beside the code (`package/ego-browser/src/**/*.test.mjs`) and in `package/ego-browser/test/*.test.js` for source-side integration and workflow checks.
- `package/ego-browser/scripts/` — `build.mjs` (esbuild per-file → `dist/src`, rollup bundle → `dist/out/index.js`, copies `skills/ego-browser` → `dist/out/ego-browser`), `validate-site-skills.ts`, `run-real-browser-e2e.mjs`, and the `real-browser-e2e/` suite.
- `skills/ego-browser/` — agent skill package: `SKILL.md` (canonical agent-facing usage guide), `references/install.md`, `scripts/install.sh`.
- `skills/ego-browser/learnings/` — reusable per-site experience packs (`manifest.json` + `notes/` + `tools/` + `browser-tools/`).

## Development Commands
Run from `package/ego-browser/`:
- `npm test` — build, typecheck, then `node --test` over `src/**/*.test.mjs` and `test/*.test.js`.
- `npm run e2e` — run the real-browser E2E suite covering environment setup, helper surface, task spaces, navigation, observation, interactions, locators, downloads, and screencast.
- `npm run validate:site-skills` (alias `validate:learnings`) — validate learned site skills.
- `node dist/out/index.js <<'JS' ... JS` — run the built CLI from this checkout (requires an `ego` runtime for real browser work; `--doctor`, `--reload`, `-h` also supported).

## Code Conventions & Common Patterns
- ESM only (`"type": "module"`); Node 22+.
- Public helpers are camelCase, verb-first for async actions (`ensureSession`, `runSiteTool`).
- Timeouts and delays in the Playwright-style `page`, locator, navigation, and browser helpers are in milliseconds. Exceptions: `fetch.server` / `fetch.browser` timeouts and `taskSpaces.waitForAgentControl` interval/timeout are in seconds; names ending in `Ms` are always milliseconds.
- Helpers are injected into the script scope, not imported by agent scripts.
- New public helpers go through `helperContext()` in `src/helpers.ts` and need JSDoc (it feeds `help()`); keep `SKILL.md` in sync.
- Snapshot refs (`@N`) are short-lived; re-snapshot after navigation or DOM changes and prefer stable `loc=...` values for reuse.
- Element-resolution failures should use `ElementResolutionError` with an honest `transient`/`permanent` kind — wait loops rely on it.
- The code prefers the small shared state singleton (`src/state.ts`) over threading connection state through call sites.
- Site skills must stay site-shaped and verifiable: stable URLs, durable selectors, no pixel coordinates, no secrets.

## Testing & QA
- Framework: Node's built-in runner (`node --test`), assertions via `node:assert/strict`.
- Colocated runtime tests run against the build output (`dist/src/...`); `test/*.test.js` covers source-side fixtures and workflow integration. `npm test` builds first.
- Behavior-focused tests inject overrides (`__testing.setOverrides`) or a `FakeEgo` double (see `src/helpers.test.mjs`, `src/taskspace-e2e.test.mjs`).
- Cover session handling, locator resolution, helper behavior, and site-skill validation when changing runtime code; run `npm run validate:site-skills` for learning changes.
