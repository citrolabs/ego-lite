# Repository Guidelines

## Project Overview
`ego-browser` is a Node.js CDP browser-automation CLI for AI agents. It drives a real Chrome session through `ego` helpers, exposes a compact snapshot/ref workflow, and layers reusable site-specific knowledge on top of the browser runtime.

## Architecture & Data Flow
- `package/ego-browser/bin/ego-browser.js` is the entrypoint.
  - Direct CLI execution calls `runMain()`.
  - Importing the package installs the SDK onto `globalThis`.
- `package/ego-browser/src/run.js` reads JavaScript from stdin and executes it inside an async function with helper APIs injected as parameters.
- `package/ego-browser/src/helpers.js` composes the user-facing helper surface: navigation, observation, waits, pointer/keyboard/file helpers, `js()`, `cdp()`, and site-skill execution helpers.
- `package/ego-browser/src/browser-runtime.js` owns CDP transport, session attachment/caching, event buffering, and session invalidation.
- `package/ego-browser/src/element-resolver.js` resolves refs, locators, CSS/XPath, and AX-based targets.
- `package/ego-browser/src/site-skills.js` discovers and loads site skills from `skills/ego-browser/learnings/`.
- Shared mutable runtime state lives in `package/ego-browser/src/state.js`.

Data flow is generally:
`stdin JS` → `runMain()` → injected helpers → browser runtime/CDP → snapshot or DOM/AX resolution → optional site skills/tools.

## Key Directories
- `package/ego-browser/src/` — runtime, helpers, resolver, and site-skill loading.
- `package/ego-browser/bin/` — CLI entrypoint.
- `package/ego-browser/test/` — Node test suite for runtime, helpers, navigation, state, and site skills.
- `package/ego-browser/scripts/` — validation scripts for learned site skills.
- `skills/ego-browser/` — agent skill package, docs, references, and learned site skills.
- `skills/ego-browser/learnings/` — reusable per-site experience packs.
- `skills/ego-browser/references/` — maintenance guidance for learned skills.

## Development Commands
Run from `package/ego-browser/`:
- `npm test` — run the Node test suite (`node --test`).
- `npm run validate:learnings` — validate learned site skills.
- `npm run validate:site-skills` — same validator entrypoint.
- `node bin/ego-browser.js <<'JS' ... JS` — run the CLI from this checkout.
- `npm link` — make the CLI available on PATH locally.

## Code Conventions & Common Patterns
- ESM only: `"type": "module"`.
- Node 22+ is required by `package/ego-browser/package.json`.
- Public helpers are camelCase only; avoid snake_case aliases.
- Async helpers use verb-first names such as `runMain`, `ensureSession`, `siteSkillsForUrl`, and `runSiteTool`.
- The code prefers a small shared state singleton over threading connection state through many call sites.
- Helpers are designed to be injected into the script scope, not imported manually by agent scripts.
- Snapshot refs like `@e1` are short-lived; re-snapshot after navigation or DOM changes and prefer stable `loc=...` values for reuse.
- Site skills must stay site-shaped and verifiable: stable URLs, durable selectors, no pixel coordinates, no secrets.

## Important Files
- `package/ego-browser/bin/ego-browser.js` — CLI/SDK bootstrap.
- `package/ego-browser/src/run.js` — stdin executor.
- `package/ego-browser/src/browser-runtime.js` — CDP transport and session handling.
- `package/ego-browser/src/helpers.js` — helper composition.
- `package/ego-browser/src/site-skills.js` — site-skill discovery and execution.
- `package/ego-browser/scripts/validate-site-skills.js` — skill manifest validator.
- `skills/ego-browser/SKILL.md` — canonical agent-facing usage guide.
- `skills/ego-browser/scripts/check-domain-learned.js` — checks whether a domain is already covered by a learning.
- `skills/ego-browser/learnings/_template/TEMPLATE.md` — starting point for new learnings.

## Runtime/Tooling Preferences
- Use Node.js 22 or newer.
- Package manager is npm.
- The runnable CLI lives in `package/ego-browser`; the skill package under `skills/ego-browser` is documentation and reusable learning assets, not the executable CLI.
- By default the CLI loads agent workspace content from `../../skills/ego-browser`; override with `EGO_BROWSER_AGENT_WORKSPACE`.
- Learned site skills are always active and are read on each helper call.

## Testing & QA
- Test framework: Node’s built-in test runner via `node --test`.
- Assertions use `node:assert/strict`.
- Tests are behavior-focused and rely on temporary workspaces plus injected overrides.
- Validate changes that affect learned skills with `npm run validate:site-skills`.
- Prefer covering session handling, locator resolution, helper behavior, and site-skill validation when changing runtime code.

## The Solution

Four principles in one file that directly address these issues:

| Principle | Addresses |
|-----------|-----------|
| **Think Before Coding** | Wrong assumptions, hidden confusion, missing tradeoffs |
| **Simplicity First** | Overcomplication, bloated abstractions |
| **Surgical Changes** | Orthogonal edits, touching code you shouldn't |
| **Goal-Driven Execution** | Leverage through tests-first, verifiable success criteria |

## The Four Principles in Detail

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

LLMs often pick an interpretation silently and run with it. This principle forces explicit reasoning:

- **State assumptions explicitly** — If uncertain, ask rather than guess
- **Present multiple interpretations** — Don't pick silently when ambiguity exists
- **Push back when warranted** — If a simpler approach exists, say so
- **Stop when confused** — Name what's unclear and ask for clarification

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

Combat the tendency toward overengineering:

- No features beyond what was asked
- No abstractions for single-use code
- No "flexibility" or "configurability" that wasn't requested
- No error handling for impossible scenarios
- If 200 lines could be 50, rewrite it

**The test:** Would a senior engineer say this is overcomplicated? If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting
- Don't refactor things that aren't broken
- Match existing style, even if you'd do it differently
- If you notice unrelated dead code, mention it — don't delete it

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused
- Don't remove pre-existing dead code unless asked

**The test:** Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform imperative tasks into verifiable goals:

| Instead of... | Transform to... |
|--------------|-----------------|
| "Add validation" | "Write tests for invalid inputs, then make them pass" |
| "Fix the bug" | "Write a test that reproduces it, then make it pass" |
| "Refactor X" | "Ensure tests pass before and after" |

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let the LLM loop independently. Weak criteria ("make it work") require constant clarification.
