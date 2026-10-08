# Repository Guidelines

## Project Overview

`ego-browser` is a Node.js CDP browser-automation harness for AI agents. It drives the ego lite browser through `globalThis.ego` bindings (provided by the closed-source ego lite app), exposes a compact snapshot/ref workflow, and layers reusable site-specific knowledge ("learnings") on top of the browser runtime.

This repo contains the open-source harness and the agent skill package — **not** the browser itself. The ego lite app bundles its own `ego-browser` binary that embeds this runtime. The Skill has two layers: `skills/ego-browser/` is a thin entry Skill that tells agents to run `ego-browser skill`, and `package/ego-browser/skill-body/SKILL.md` is the versioned usage guide that command prints (`ego-browser nodejs <<'EOF' ... EOF`). The repo CLI built here takes the heredoc directly on stdin with no subcommand.

## Architecture & Data Flow

- `package/ego-browser/src/index.ts` is the entrypoint with two startup paths:
  - Executed directly as a CLI → `runMain()` (reads JavaScript from stdin, executes it).
  - Imported as a module (how the app embeds it) → `installEgoSdk(globalThis)`.
- Both paths expose the same helper surface. `public-api-schema.ts` is the
  source of truth for the v2 API shown by `help()`;
  `helpers.ts` combines it with the frozen v1 compatibility surface.
- `src/run.ts` executes stdin JavaScript inside an async function with the helpers injected as parameters.
- `src/browser-runtime.ts` owns CDP transport over `ego.sendCDPMessage`, session attach/caching (2s TTL, auto re-attach on session loss), the buffered event queue (10k cap), and JS dialog tracking.
- `src/cdp-eval.ts` provides `cdp()` and `js()` (string-expression evaluation; top-level `return` is auto-wrapped in an IIFE).
- `src/element-resolver.ts` resolves all target forms — `@N` refs, `loc=css:` / `loc=role:` / `loc=href:` locators, `xpath=`, raw CSS — and classifies failures as `transient` (retryable) or `permanent`.
- `src/page-ref-registry.ts` + `src/page-ledger.ts`: v2 Page refs (`@21`, not `@e21`) are SDK-assigned ids bound to one frame/document/backend node. Their mappings and invalidation persist across rounds; partial snapshots merge by node identity and full snapshots replace the active set. Missing refs require a fresh snapshot. `src/ref-map.ts` + `src/ref-state.ts` retain the v1 native-ref refresh behavior.
- `src/driver/` — `nav` (tabs, navigation), `pointer` (click/scroll/drag), `keyboard`, `observe` (snapshot/screenshot), `waits`, `files` (upload), `element-ops` (objectId handles), `load`.
- `src/learning/` — discovery, validation, and execution of site skills from `skill-body/learnings/<site>/manifest.json` (`runSiteTool`, `runSiteBrowserTool`, `learnContext`).
- `src/state.ts` is the shared mutable runtime state singleton; `src/env.ts` resolves the agent workspace (`EGO_BROWSER_AGENT_WORKSPACE`, falling back to the guide dir bundled next to the build output, then the package's `skill-body`).
- `src/help-runtime.ts` parses the built bundle's JSDoc with acorn at runtime to power `help()` — JSDoc on exported helpers is therefore user-facing documentation.

Data flow: `stdin JS` → `runMain()` → `helperContext()` helpers → browser runtime/CDP → snapshot or DOM/AX resolution → optional site tools → `cliLog(...)`.

## Task Spaces

Task spaces are isolated browsing contexts with an ownership model (`agent` / `user`):

- New scripts use `taskSpace(nameOrId)` and operate through the returned
  `TaskSpace` and labeled `Page` objects.
- `task.pages()` returns managed Page handles; `task.tabs()` returns the full
  managed and unmanaged tab inventory.
- Control handoff uses `task.handOff()` and `takeOverTaskSpace(spaceId)`.
- The old global helpers remain available only for v1 script compatibility.

## Key Directories

- `package/ego-browser/src/` — runtime, helpers, resolver, drivers, learning subsystem.
- `package/ego-browser/src/**/*.test.mjs` — tests are colocated with the code (there is no separate `test/` directory).
- `package/ego-browser/scripts/` — `build.mjs` (esbuild per-file → `dist/src`, rollup bundle → `dist/out/index.js`, renders `skill-body/SKILL.md` → `dist/out/ego-browser/SKILL.md` with version and end markers and copies `skill-body/learnings` next to it, copies the entry Skill → `dist/out/agent-skills/ego-browser`), `validate-site-skills.ts`, and the real-browser E2E runner.
- `package/ego-browser/skill-body/SKILL.md` — canonical agent-facing usage guide, printed by `ego-browser skill`.
- `skills/ego-browser/` — thin entry Skill published to skill markets and plugins: `SKILL.md`, `references/install.md`, `references/clearing-state.md`, `scripts/install.sh`. See `docs/ego-browser-skill-command.md` for the browser-side contract.
- `package/ego-browser/skill-body/learnings/` — reusable per-site experience packs (`manifest.json` + `notes/` + `tools/` + `browser-tools/`).

## Development Commands

Run from `package/ego-browser/`:

- `npm test` — build, typecheck, then `node --test` over `src/**/*.test.mjs`.
- `npm run e2e` — self-contained real-browser E2E suite using the current
  checkout through `--sdk-path`.
- `npm run validate:site-skills` — validate learned site skills.
- `node dist/out/index.js <<'JS' ... JS` — run the built CLI from this checkout (requires an `ego` runtime for real browser work; `-h` is also supported).

## Code Conventions & Common Patterns

- ESM only (`"type": "module"`); Node 22+.
- Public helpers are camelCase, verb-first for async actions (`ensureSession`, `runSiteTool`).
- V2 `TaskSpace` and `Page` time parameters are milliseconds. The v1
  compatibility helpers keep their original units.
- Helpers are injected into the script scope, not imported by agent scripts.
- New v2 APIs go through `public-api-schema.ts`; keep runtime validation,
  `help()`, architecture, and `skill-body/SKILL.md` in sync.
- Snapshot refs (`@N`) are short-lived; re-snapshot after navigation or DOM changes and prefer stable `loc=...` values for reuse.
- Element-resolution failures should use `ElementResolutionError` with an honest `transient`/`permanent` kind — wait loops rely on it.
- The code prefers the small shared state singleton (`src/state.ts`) over threading connection state through call sites.
- Site skills must stay site-shaped and verifiable: stable URLs, durable selectors, no pixel coordinates, no secrets.

## Testing & QA

- Framework: Node's built-in runner (`node --test`), assertions via `node:assert/strict`.
- Tests run against the build output (`dist/src/...`) — `npm test` builds first.
- Behavior-focused tests inject overrides (`__testing.setOverrides`) or a
  `FakeEgo` double (see `src/helpers.test.mjs` and `src/page-model.test.mjs`).
- Cover session handling, locator resolution, helper behavior, and site-skill validation when changing runtime code; run `npm run validate:site-skills` for learning changes.
- `npm run e2e` is the self-contained real-browser gate. It builds the current
  checkout, passes the resulting absolute bundle through `--sdk-path`, starts a
  local fixture server, uses a unique temporary task space, and cleans it up.
  Do not link another runtime, reuse a prior E2E space, or manually take control
  while the suite is running.
