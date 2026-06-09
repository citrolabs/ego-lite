# Contributing Guide

Thanks for your interest in contributing to **ego-browser (ego-lite)**! This guide is aimed at developers who want to build on top of the project or submit patches upstream. It covers the architecture, local development workflow, code conventions, and PR process.

> For the project vision, see [`README.md`](./README.md). For the agent-facing runbook, see [`skills/ego-browser/SKILL.md`](./skills/ego-browser/SKILL.md) (or [`SKILL.zh.md`](./skills/ego-browser/SKILL.zh.md)). For repo-level guidance, see [`AGENTS.md`](./AGENTS.md).

---

## Table of Contents

- [1. What This Project Is](#1-what-this-project-is)
- [2. Repository Layout](#2-repository-layout)
- [3. Tech Stack & Runtime](#3-tech-stack--runtime)
- [4. Local Development Setup](#4-local-development-setup)
- [5. Architecture Overview](#5-architecture-overview)
- [6. Key Modules](#6-key-modules)
- [7. Site Learnings](#7-site-learnings)
- [8. Testing & Quality](#8-testing--quality)
- [9. Code Style & Conventions](#9-code-style--conventions)
- [10. Commit & PR Process](#10-commit--pr-process)
- [11. Release & CI](#11-release--ci)
- [12. Design Principles (The Four Principles)](#12-design-principles-the-four-principles)

---

## 1. What This Project Is

`ego-browser` is a Chromium browser designed for collaboration between humans and AI agents. This repository (`ego-lite`) provides the **Node.js helper runtime** and **agent skill package** that run on top of that browser.

- **This repo does not ship the browser binary**; the browser must be installed separately.
- Agents invoke the CLI by running `ego-browser nodejs <<'EOF' ... EOF` from inside the browser. Each heredoc runs in a fresh Node process with all helpers injected into scope.
- State (task spaces, tabs, login sessions) lives on the browser side, not in the Node process.

---

## 2. Repository Layout

```
ego-lite/
├── package/ego-browser/        # The runnable npm package (TypeScript)
│   ├── src/                    # Core source
│   │   ├── index.ts            # SDK / CLI bootstrap
│   │   ├── run.ts              # stdin executor, CLI entry
│   │   ├── helpers.ts          # Public helper surface composition
│   │   ├── browser-runtime.ts  # CDP transport and session cache
│   │   ├── element-resolver.ts # @eN / CSS / XPath / ARIA resolution
│   │   ├── cdp-eval.ts         # cdp() / js() helpers
│   │   ├── state.ts            # Shared mutable runtime state (singleton)
│   │   ├── env.ts              # Environment variables
│   │   ├── driver/             # Capability-scoped driver modules
│   │   │   ├── pointer.ts      # Click / hover / drag / scroll
│   │   │   ├── keyboard.ts     # Typing / key dispatch
│   │   │   ├── nav.ts          # Page and tab navigation
│   │   │   ├── observe.ts      # Snapshot / screenshot / events
│   │   │   ├── waits.ts        # Wait primitives
│   │   │   └── files.ts        # File upload
│   │   └── learning/           # Site skill loading and validation
│   ├── scripts/
│   │   ├── build.mjs           # esbuild + rollup bundler
│   │   └── validate-site-skills.ts
│   ├── test/                   # node --test suites
│   ├── artifacts/              # Build output (published to GitHub Release by CI)
│   ├── dist/                   # tsc output (gitignored)
│   ├── package.json
│   └── tsconfig.json
├── skills/ego-browser/         # Agent skill package
│   ├── SKILL.md / SKILL.zh.md  # Agent usage guide
│   └── learnings/<site>/       # Per-site knowledge packs (github / google / x-com ...)
├── spec/                       # Spec references
├── public/                     # Demo assets
├── .github/workflows/ci.yml    # CI (test + release)
├── .claude-plugin/             # Claude Code plugin marketplace manifest
├── AGENTS.md                   # Repo-level agent / contributor guidance
└── README.md
```

---

## 3. Tech Stack & Runtime

| Item | Choice |
| --- | --- |
| Language | TypeScript (`tsc --noEmit` for typecheck only) |
| Runtime | Node.js **>= 22**, ESM only (`"type": "module"`) |
| Package manager | npm (commit `package-lock.json`) |
| Bundler | esbuild + rollup (output: `artifacts/ego-browser/index.js`) |
| Tests | Node built-in `node --test` + `node:assert/strict` |
| Runtime deps | Only `acorn` (lightweight parsing) |
| Browser transport | Chrome DevTools Protocol (CDP) directly — **no Puppeteer / Playwright** |

---

## 4. Local Development Setup

> All commands run from `package/ego-browser/`.

```bash
# 1. Install dependencies
cd package/ego-browser
npm ci

# 2. Build (produces dist/ and artifacts/ego-browser/index.js)
npm run build

# 3. Typecheck
npm run typecheck

# 4. Run tests (automatically includes build + typecheck)
npm test

# 5. Validate site learnings
npm run validate:site-skills    # alias: validate:learnings
```

**Calling the CLI directly** (for local debugging):

```bash
node artifacts/ego-browser/index.js <<'JS'
await waitForLoad()
cliLog(await pageInfo())
JS
```

**CLI debug flags** (see `src/run.ts`):

- `--help` / `-h`: print usage
- `--doctor`: check browser and connection state
- `--reload`: force-rebuild the CDP connection on next call
- `--debug-clicks`: equivalent to `EGO_BROWSER_DEBUG_CLICKS=1`

**Key environment variables**:

| Variable | Purpose |
| --- | --- |
| `EGO_BROWSER_AGENT_WORKSPACE` | Override skill workspace root (defaults to `skills/ego-browser` inside the repo) |
| `EGO_BROWSER_NAME` | Browser instance name (default `default`) |
| `EGO_BROWSER_DEBUG_CLICKS` | Enable click debug logging |

---

## 5. Architecture Overview

```
       ┌────────────────────────────────────────────────┐
       │  stdin (JS code inside the heredoc)            │
       └──────────────────┬─────────────────────────────┘
                          │
                          ▼
               ┌──────────────────────┐
               │ run.ts  runMain()    │  wraps stdin in AsyncFunction, injects helpers
               └──────────┬───────────┘
                          │
                          ▼
           ┌──────────────────────────────┐
           │ helpers.ts (public API)      │
           │  ├─ task-space helpers       │
           │  ├─ driver/* capabilities    │
           │  ├─ cdp() / js()             │
           │  └─ learning helpers         │
           └──────────────┬───────────────┘
                          │
                          ▼
           ┌──────────────────────────────┐
           │ browser-runtime.ts           │
           │  CDP transport / sessions /  │
           │  events                      │
           └──────────────┬───────────────┘
                          │  Chrome DevTools Protocol
                          ▼
                  ┌──────────────┐
                  │ ego-browser  │  browser holds tabs / task spaces / login state
                  └──────────────┘
```

**Core data flow**:

```
stdin JS → runMain() → injected helpers → CDP / DOM / AX resolution → optional Site Skill
```

### Task Space Model

A `Task Space` is an isolated browsing context provided by ego-browser: it owns its own tab set but inherits the user's login state.
Because every heredoc runs in a fresh Node process, **the agent must call `useOrCreateTaskSpace(name)` at the start of every heredoc to re-attach to the same task space**, and end with `completeTaskSpace(name, { keep })` in the final round.

Control (`agent` ↔ `user`) is handed off via the `handOffTaskSpace` / `takeOverTaskSpace` / `waitForAgentControl` protocol — for example, when the user needs to log in manually or solve a CAPTCHA.

---

## 6. Key Modules

| File | Responsibility |
| --- | --- |
| `src/index.ts` | SDK injection (`installEgoSdk`); decides whether to run as CLI or be imported as a library |
| `src/run.ts` | Reads stdin, builds an `AsyncFunction`, and invokes it with helpers as named arguments |
| `src/helpers.ts` | Composes and exports the helper set exposed to heredocs |
| `src/browser-runtime.ts` | Maintains the CDP connection, session cache, and event buffer for the browser's ego runtime |
| `src/element-resolver.ts` | Resolves `@eN` refs, CSS, XPath, and ARIA/role to backend nodeIds |
| `src/cdp-eval.ts` | `cdp()` raw CDP calls + `js()` in-page evaluation |
| `src/state.ts` | Shared mutable state singleton (`send`, `platform`, `agentWorkspace`, session caches). Tests can inject stubs via `setOverrides()` |
| `src/driver/*` | Minimal-dependency primitives per capability; only call into `cdp()` |
| `src/learning/index.ts` | Discovers and loads `learnings/<site>/`, exposes `runSiteTool` / `runSiteBrowserTool` |
| `src/learning/validate-learning-format.ts` | Site manifest validator |
| `scripts/build.mjs` | Uses `.build.lock` to prevent concurrent builds; esbuild transform + rollup bundle into a single file |

> Historical note: the repo is migrating from `.js` to `.ts`. If `AGENTS.md` still mentions `.js` files, defer to the current `src/*.ts`.

---

## 7. Site Learnings

Each site learning pack lives under `skills/ego-browser/learnings/<site>/`, with this shape:

```
learnings/<site>/
├── manifest.json        # Site metadata, domain matching, declared tools and parameter schemas
├── notes/*.md           # Entry points, structure, edge cases — human-readable notes
├── tools/*.js           # Node-side tools (run inside the CLI process)
└── browser-tools/*.js   # Browser-side tools (injected and run in the page)
```

**Adding a new site learning pack**:

1. Copy the structure from an existing pack (recommend `learnings/github/`).
2. Write `manifest.json` with `id`, `name`, `domains[]`, `notes[]`, `nodeTools{}`, `browserTools{}`, and parameter schemas.
3. Implement `tools/*.js` and `browser-tools/*.js`.
4. Validate:
   ```bash
   cd package/ego-browser
   npm run validate:site-skills
   ```
5. Add at least one behavior test in the `test/site-skills.test.js` style.

**Hard constraints for learning packs**:

- Use **stable URLs** and **stable selectors** (CSS / ARIA / text) only
- Never write **pixel coordinates**, **secrets/tokens**, or **task narration**
- Capture the *shape* of the site, not your task — a "map", not a "diary"

---

## 8. Testing & Quality

- Test framework: `node --test` with `node:assert/strict`
- Test files: `package/ego-browser/test/*.test.js`, split by responsibility (runtime / helpers / resolver / nav-driver / site-skills / build / state ...)
- Style: behavior-driven, using **temp workspaces + `setOverrides()`** for stub injection — no real browser launches

**Minimum pre-submit bar**:

```bash
cd package/ego-browser
npm test                       # must pass
npm run validate:site-skills   # if learnings changed
```

**When to add/extend tests**:

- Changes to session / connection handling → add cases in `browser-runtime.test.js` / `session-injection.test.js`
- Changes to the resolver → `element-resolver.test.js`
- New helper → `helpers.test.js` or the matching driver test
- Changes to learning loading → `site-skills.test.js` / `validate-site-skills.test.js`

---

## 9. Code Style & Conventions

- **ESM only**: `import` paths use the `.js` extension (NodeNext resolution)
- **Node 22+**
- **All public helpers are camelCase** — do not provide `snake_case` aliases
- **Async helpers start with a verb**: `runMain`, `ensureSession`, `siteSkillsForUrl`, `runSiteTool`, ...
- **TypeScript non-strict mode**: `strict: false`, but keep explicit type signatures
- **Shared state goes through the `state.ts` singleton** — do not thread `connection` / `send` through function parameters
- **Helpers are injected, not imported**: agent scripts do not `import`; all helpers are placed in scope by `run.ts`
- **Snapshot refs (`@eN`) are short-lived**: re-snapshot after any DOM mutation; for long-lived values use `loc=...` or stable CSS / ARIA
- **No lint / prettier**: style is enforced by convention and code review. When editing, blend in with the surrounding code instead of introducing a new style

---

## 10. Commit & PR Process

### Branches and commits

- Branch from latest `main`: `git checkout -b <type>/<short-description>`
- Follow [Conventional Commits](https://www.conventionalcommits.org/); see recent history for tone:
  ```
  fix(ego-browser): format object-shaped ego errors with message/JSON
  test(ego-browser): expand e2e coverage for handoff and control probing
  ```
- Common `type`s: `feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `ci`
- `scope` is usually `ego-browser` or the learning pack name (e.g. `learnings/github`)

### Pull Request

A PR description should include at minimum:

1. **What** — one-sentence summary of the change
2. **Why** — motivation / linked issue
3. **How to verify** — repro / verification steps; attach screenshots or heredoc examples for UI behavior
4. Impact callout (does it touch the helper surface? does the agent side need updates?)

Add at least one release-note label so generated releases are grouped correctly:
`feat` / `fix` / `docs` / `chore` / `ci` / `refactor`.

### Review Checklist

- [ ] `npm test` is green
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] If learnings changed, `npm run validate:site-skills` passes
- [ ] Change is "minimal surgical edit" (see §12)
- [ ] No undeclared runtime dependencies introduced
- [ ] Public helper names / docs are kept in sync (update both `SKILL.md` and `SKILL.zh.md`)

---

## 11. Release & CI

- CI config: `.github/workflows/ci.yml`
  - Every push / PR: on Node 22 + ubuntu-latest, runs `npm ci` → `npm test` → `npm run validate:site-skills`
  - After push to `dev`: the `release` job builds a `nightly-YYYYMMDD-SHA` prerelease
  - Tags matching `vX.Y.Z-beta.N`: build a beta prerelease
  - Tags matching `vX.Y.Z`: build a stable release and mark it as latest
- Release notes are generated automatically from merged PRs and grouped by `.github/release.yml` labels: Features, Fixes, Documentation, Maintenance, and Other Changes.
- Normal flow: merge features into `dev` for nightly, cut beta tags from `dev`, then merge `dev` to `main` and cut stable `vX.Y.Z` tags from `main`.
- The build script `scripts/build.mjs` uses `.build.lock` to prevent concurrent builds.

---

## 12. Design Principles (The Four Principles)

This repo strongly endorses the four principles below (see [`AGENTS.md`](./AGENTS.md)). Both human contributors and AI agents should apply them on every change:

| Principle | Meaning |
| --- | --- |
| **Think Before Coding** | Don't assume, don't paper over confusion; surface trade-offs explicitly and push back when needed |
| **Simplicity First** | The smallest amount of code that solves the problem; no speculative abstractions or configuration |
| **Surgical Changes** | Change only what needs to change; preserve the existing style; do not opportunistically "improve" unrelated code |
| **Goal-Driven Execution** | Translate the task into a verifiable goal; write the check first, then iterate until it passes |

> "Every changed line should trace back to the requirement of this task."

---

## Feedback & Contact

- Issues / discussions: <https://github.com/CitroLabs/ego-lite/issues>
- License: MIT © 2026 CitroLabs

Issues, PRs, and new site learnings are all welcome — make ego-browser smarter with your next contribution.
