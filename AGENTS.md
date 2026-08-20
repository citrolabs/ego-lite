# Repository Guidelines

## Project Overview
`ego-browser` is a Node.js CDP browser-automation harness for AI agents. It drives the ego lite browser through `globalThis.ego` bindings (provided by the closed-source ego lite app), exposes a compact snapshot/ref workflow, and layers reusable site-specific knowledge ("learnings") on top of the browser runtime.

This repo contains the open-source harness and the agent skill package — **not** the browser itself. The ego lite app bundles its own `ego-browser` binary that embeds this runtime; `skills/ego-browser/SKILL.md` documents that binary's usage (`ego-browser nodejs <<'EOF' ... EOF`). The repo CLI built here takes the heredoc directly on stdin with no subcommand.

## Architecture & Data Flow
- `package/ego-browser/src/index.ts` is the entrypoint with two startup paths:
  - Executed directly as a CLI → `runMain()` (reads JavaScript from stdin, executes it).
  - Imported as a module (how the app embeds it) → `installEgoSdk(globalThis)`.
- Both paths expose the same helper surface, built by `helperContext()` in `src/helpers.ts` — the single source of truth for what agents can call (including `help()` and `agent_helpers.js` extensions).
- `src/run.ts` executes stdin JavaScript inside an async function with the helpers injected as parameters.
- `src/browser-runtime.ts` owns CDP transport over `ego.sendCDPMessage`, session attach/caching (2s TTL, auto re-attach on session loss), the buffered event queue (10k cap), and JS dialog tracking.
- `src/cdp-eval.ts` provides `cdp()` and `js()` (string-expression evaluation; top-level `return` is auto-wrapped in an IIFE).
- `src/element-resolver.ts` resolves all target forms — `@N` refs, `loc=css:` / `loc=role:` / `loc=href:` locators, `xpath=`, raw CSS — and classifies failures as `transient` (retryable) or `permanent`.
- `src/ref-map.ts` + `src/ref-state.ts`: refs are numeric `backendNodeId`s (`@21`, not `@e21`). The map is rebuilt on every snapshot; using a ref while the map is empty triggers an automatic re-snapshot, which is what makes refs work across heredoc rounds.
- `src/driver/` — `nav` (tabs, navigation), `pointer` (click/scroll/drag), `keyboard`, `observe` (snapshot/screenshot), `waits`, `files` (upload), `element-ops` (objectId handles), `load`.
- `src/learning/` — discovery, validation, and execution of site skills from `skills/ego-browser/learnings/<site>/manifest.json` (`runSiteTool`, `runSiteBrowserTool`, `learnContext`).
- `src/state.ts` is the shared mutable runtime state singleton; `src/env.ts` resolves the agent workspace (`EGO_BROWSER_AGENT_WORKSPACE`, falling back to the skill dir bundled next to the build output, then the repo's `skills/ego-browser`).
- `src/help-runtime.ts` parses the built bundle's JSDoc with acorn at runtime to power `help()` — JSDoc on exported helpers is therefore user-facing documentation.

Data flow: `stdin JS` → `runMain()` → `helperContext()` helpers → browser runtime/CDP → snapshot or DOM/AX resolution → optional site tools → `console.log(...)`.

## Task Spaces
Task spaces are isolated browsing contexts with an ownership model (`agent` / `user`):
- `useOrCreateTaskSpace(nameOrId)` reuses an agent-owned space or creates a new one; it no longer auto-claims user-owned spaces. Use `claimTaskSpace(nameOrId)` to take ownership of a user-owned space. Ids are numeric; prefer `task.id` over names across rounds.
- `switchTaskSpace` requires agent ownership; `newTaskSpace` creates; `completeTaskSpace(nameOrId, { keep })` finishes (`keep` is mandatory).
- Control handoff: `handOffTaskSpace` / `takeOverTaskSpace` / `waitForAgentControl`.
- Idle reclamation (`src/taskspace-reclaim.ts` + `src/taskspace-activity.ts`): `run.ts` `execute()` runs `reclaimIdleTaskSpaces()` once before the agent script, auto-closing agent-owned task spaces left idle by earlier sessions so their renderer processes don't pile up. `helpers.ts` `selectTaskSpace` touches a per-space timestamp (persisted atomically to `EGO_RECLAIM_STATE_FILE`, default `~/.local/share/ego/reclaim-state.json`). First-sight seeding skips spaces with no record (created before this feature shipped, or in use by a concurrent session) — they only become reclaimable after the idle window elapses. Only `ownership === "agent"` is ever reclaimed. Env: `EGO_RECLAIM_IDLE_S` (default 7200s = 2h), `EGO_RECLAIM_MAX_SPACES` (default 8), `EGO_RECLAIM_DISABLE` (1/true). Tests: `src/taskspace-{activity,reclaim}.test.mjs`.

## Key Directories
- `package/ego-browser/src/` — runtime, helpers, resolver, drivers, learning subsystem.
- `package/ego-browser/src/**/*.test.mjs` — tests are colocated with the code (there is no separate `test/` directory).
- `package/ego-browser/scripts/` — `build.mjs` (esbuild per-file → `dist/src`, rollup bundle → `dist/out/index.js`, copies `skills/ego-browser` → `dist/out/ego-browser`), `validate-site-skills.ts`, `run-e2e.sh`.
- `skills/ego-browser/` — agent skill package: `SKILL.md` (canonical agent-facing usage guide), `references/install.md`, `scripts/install.sh`.
- `skills/ego-browser/learnings/` — reusable per-site experience packs (`manifest.json` + `notes/` + `tools/` + `browser-tools/`).

## Development Commands
Run from `package/ego-browser/`:
- `npm test` — build, typecheck, then `node --test` over `src/**/*.test.mjs`.
- `npm run e2e` — task-space e2e suite (`src/taskspace-e2e.test.mjs`).
- `npm run validate:site-skills` (alias `validate:learnings`) — validate learned site skills.
- `node dist/out/index.js <<'JS' ... JS` — run the built CLI from this checkout (requires an `ego` runtime for real browser work; `--doctor`, `--reload`, `-h` also supported).

## Code Conventions & Common Patterns
- ESM only (`"type": "module"`); Node 22+.
- Public helpers are camelCase, verb-first for async actions (`ensureSession`, `runSiteTool`).
- Time parameters are in seconds unless the name ends in `Ms`.
- Helpers are injected into the script scope, not imported by agent scripts.
- New public helpers go through `helperContext()` in `src/helpers.ts` and need JSDoc (it feeds `help()`); keep `SKILL.md` in sync.
- Snapshot refs (`@N`) are short-lived; re-snapshot after navigation or DOM changes and prefer stable `loc=...` values for reuse.
- Element-resolution failures should use `ElementResolutionError` with an honest `transient`/`permanent` kind — wait loops rely on it.
- The code prefers the small shared state singleton (`src/state.ts`) over threading connection state through call sites.
- Site skills must stay site-shaped and verifiable: stable URLs, durable selectors, no pixel coordinates, no secrets.

## Testing & QA
- Framework: Node's built-in runner (`node --test`), assertions via `node:assert/strict`.
- Tests run against the build output (`dist/src/...`) — `npm test` builds first.
- Behavior-focused tests inject overrides (`__testing.setOverrides`) or a `FakeEgo` double (see `src/helpers.test.mjs`, `src/taskspace-e2e.test.mjs`).
- Cover session handling, locator resolution, helper behavior, and site-skill validation when changing runtime code; run `npm run validate:site-skills` for learning changes.
