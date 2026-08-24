#!/usr/bin/env bash

set -euo pipefail

# Minimal macOS reproduction for Ego Lite being activated when a page-created
# popup opens. This deliberately keeps the TaskSpace Agent-owned throughout.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SDK_PATH="${PACKAGE_DIR}/dist/out/index.js"
DEFAULT_EGO_CLI="/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser"
EGO_CLI="${EGO_BROWSER_REAL_E2E_CLI:-${DEFAULT_EGO_CLI}}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This reproduction currently targets Ego Lite on macOS." >&2
  exit 1
fi

if [[ ! -x "${EGO_CLI}" ]]; then
  echo "Ego Lite CLI was not found at: ${EGO_CLI}" >&2
  echo "Override it with EGO_BROWSER_REAL_E2E_CLI=/path/to/ego-browser" >&2
  exit 1
fi

echo "Building the workspace SDK..."
(cd "${PACKAGE_DIR}" && npm run build)

if [[ ! -f "${SDK_PATH}" ]]; then
  echo "SDK build output was not created at: ${SDK_PATH}" >&2
  exit 1
fi

echo
echo "The popup will open in 5 seconds."
echo "Keep another application in front and watch whether Ego Lite takes focus."
sleep 5

"${EGO_CLI}" nodejs --sdk-path "${SDK_PATH}" <<'EOF'
const task = await taskSpace(`popup foreground reproduction ${Date.now()}`);

try {
  const page = task.page("p1");
  const html = `
    <!doctype html>
    <meta charset="utf-8">
    <title>Ego Lite popup foreground reproduction</title>
    <button id="open-popup">Open popup</button>
  `;

  await page.goto(
    "data:text/html;base64," + Buffer.from(html).toString("base64"),
  );
  await page.evaluate(() => {
    document.querySelector("#open-popup").addEventListener("click", () => {
      window.open("about:blank", "_blank");
    });
  });

  // A trusted browser click makes the site create a popup target. The popup
  // creation is the event under test; no handoff or permission prompt occurs.
  const receipt = await page.click("#open-popup");
  console.log(
    JSON.stringify({
      reproduced: true,
      spaceId: task.spaceId,
      ownership: task.ownership,
      popups: receipt.popups || [],
    }),
  );

  // Leave the result visible briefly, then remove all reproduction state.
  await new Promise((resolve) => setTimeout(resolve, 8_000));
} finally {
  await task.close().catch((error) => {
    console.error(`Cleanup failed for TaskSpace ${task.spaceId}: ${error.message}`);
  });
}
EOF

echo "Reproduction finished; the temporary TaskSpace was cleaned up."
