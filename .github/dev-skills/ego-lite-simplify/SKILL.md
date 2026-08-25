---
name: ego-lite-simplify
description: Find and implement evidence-backed simplifications in the ego-lite repository. Use when reviewing the codebase for dead code, duplicated state or APIs, speculative abstractions, unnecessary compatibility layers, hand-written infrastructure, excessive tests or documentation, or when the user asks to reduce code size or maintenance complexity without hiding behavior changes.
---

# Simplify ego-lite

Reduce concepts and maintenance surface, not just line count. Prefer a few well-proven deletions over a long list of guesses.

## Establish the contract

1. Read `AGENTS.md` and the design document that owns the affected behavior.
2. Inspect `git status` and preserve unrelated user changes.
3. Decide whether the request is an audit or an authorized implementation. Do not turn a cleanup into a product decision without making the behavior change explicit.
4. Identify the relevant boundary before judging code:
   - `globalThis.ego` is supplied by the closed-source app; `docs/native-bindings-api.md` documents that external contract.
   - The runtime has direct CLI and embedded SDK startup paths.
   - Public agent APIs must stay aligned across implementation, tests, `help()`, and `skills/ego-browser/SKILL.md`.
   - Browser state can outlive the short Node.js process.

## Find strong candidates

Start with production areas carrying the most state, branching, or public surface. Look for:

- Exports, helpers, events, options, fallbacks, packages, or state fields with no production consumer.
- Tests or documentation that are the only consumers of behavior that is no longer required.
- Multiple representations of the same page, task-space, session, ref, lifecycle, or output state.
- Pass-through layers that add vocabulary but no policy, isolation, or test seam.
- Compatibility code that is unnecessary on an explicitly breaking branch.
- Generality with no current product use, such as unsupported concurrency modes or unused extension points.
- Special cases, rollback paths, or validation that exist only to protect a removable surface.
- Hand-written parsers, queues, retry logic, or utilities that a Node.js built-in or healthy dependency can replace with less total code.

Do not count moving logic into a wrapper as simplification. Estimate the net result: implementation, tests, docs, public names, state transitions, and special cases removed minus new glue and dependencies added.

## Prove each candidate

Use `rg` first. Search exact symbols, method forms, event names, configuration keys, error codes, protocol strings, and dynamic registration points. Read the callers rather than relying only on static-analysis output.

Classify evidence as:

- **Production:** `package/ego-browser/src`, runtime scripts, build and loader paths, and shipped site learnings.
- **Contract:** public JSDoc consumed by `help()`, `skills/ego-browser/SKILL.md`, architecture documents, and native binding behavior.
- **Non-production:** tests, fixtures, snapshots, comments, and historical or draft documents.
- **Ambiguous:** examples and development scripts; inspect how they are invoked before deciding.

Reject or downgrade a candidate when a real production caller exists, the native contract is uncertain, the change merely relocates complexity, or the deletion requires unrelated churn. A small local cleanup may be implemented directly; a behavior or API decision belongs in the owning design document first.

## Report before broad removal

For an audit, present each worthwhile candidate with:

- The surface to remove or fold.
- Call-site and contract evidence.
- The user-visible behavior change, or “none”.
- What complexity disappears and what replacement remains.
- Confidence, risks, and the smallest verification needed.

Call out candidates that require a user decision separately from behavior-preserving cleanups.

## Implement safely

Follow spec-driven TDD when changing code:

1. Update or add a characterization test when existing behavior must remain.
2. Update the owning design or API contract before an intentional behavior change.
3. Remove the implementation and its now-obsolete tests, fixtures, exports, JSDoc, help entries, and skill documentation together.
4. Keep comments in English and explain only non-obvious constraints.
5. Prefer deleting a state or transition over adding another abstraction around it.

Run the narrowest relevant checks first. From `package/ego-browser/`, use `npm test` for runtime changes, `npm run e2e` for real task-space/browser behavior, and `npm run validate:site-skills` for learning changes. Finish with `git diff --check` and report any verification that could not run.

Never edit generated build output as the source of a simplification. Never remove a defensive path until its trust or lifecycle boundary is understood.
