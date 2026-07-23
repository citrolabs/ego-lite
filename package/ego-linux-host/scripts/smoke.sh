#!/usr/bin/env bash
# End-to-end smoke for ego-linux-host (example.com title + snapshot).
#
# Prerequisites (full smoke):
#   - Chrome/Chromium on PATH, or EGO_CHROME_PATH pointing at a binary
#   - A display for headed mode (DISPLAY set), or EGO_HEADLESS=1
#   - Built harness: cd package/ego-browser && npm ci && npm run build
#     (produces dist/src/run.js used by the CLI shim)
#   - Built host: cd package/ego-linux-host && npm run build
#
# Usage:
#   ./scripts/smoke.sh
#   EGO_LINUX_E2E=1 npm test   # opt-in automated gate in e2e-smoke.test.ts
#
# Without Chrome + display the script will fail at --doctor or navigation;
# unit tests remain green when EGO_LINUX_E2E is unset.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/bin:$PATH"
# ensure node resolves bin to this package
node "$ROOT/bin/ego-browser.mjs" --doctor
node "$ROOT/bin/ego-browser.mjs" nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('linux-smoke')
await browser.openOrReuseTab('https://example.com', { wait: true, timeout: 20000 })
const title = await page.title()
const snap = await page.snapshot()
if (!title) throw new Error('missing title')
if (!snap || !String(snap).trim()) throw new Error('empty snapshot')
console.log(JSON.stringify({ taskSpaceId: task.id, title, snapHead: String(snap).slice(0, 200) }, null, 2))
EOF
