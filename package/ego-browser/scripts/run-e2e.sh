#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== build =="
npm run build

echo "== E2E (taskspace helpers) =="
EGO_BROWSER_E2E=1 node --test src/taskspace-e2e.test.mjs
