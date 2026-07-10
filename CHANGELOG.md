# Changelog

All notable changes to the open-source ego-browser harness and bundled site learnings are documented here.

## Unreleased — 2026-07-10

### Added

- Added an X bookmarks collector that handles virtualized scrolling, deduplication, login redirects, bounded idle detection, and stable post ids/URLs.
- Added an X post/article reader that selects the requested status and extracts bounded long-form article content.
- Added integration coverage for the Playwright-style Google and X Node site tools.
- Added an explicit ESM package boundary for bundled site learnings.

### Changed

- Changed the CDP event buffer to use an advancing head and batched compaction, avoiding repeated 10,000-element array shifts under sustained event traffic.
- Split transport-facing runtime state into a dependency-free module, removing the build-time circular dependency.
- Expanded X timeline results with post ids, canonical URLs, handles, and inline links.

### Fixed

- Fixed temporary CDP sessions created by `evaluate(expression, targetId)` not being detached after success or ordinary failure.
- Preserved task-space hard-stop semantics by skipping cleanup commands after user takeover or task deactivation.
