#!/bin/sh
# Install ego-browser (Linux port).
#
# Replaces upstream's macOS installer: there is no .dmg to mount here. This
# builds the unmodified upstream harness in package/ego-browser, then links the
# Linux CDP shim from package/ego-linux onto PATH as `ego-browser`.

set -eu

BIN_DIR="${EGO_LINUX_BIN_DIR:-$HOME/.local/bin}"
LINK_PATH="$BIN_DIR/ego-browser"
# Keep in sync with CHROME_CANDIDATES in package/ego-linux/src/chrome.mjs.
CHROME_CANDIDATES="google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge"

log() { printf '%s\n' "$*" >&2; }
die() {
	log "error: $*"
	exit 1
}

[ "$(uname -s)" = "Linux" ] ||
	die "this script is the Linux port's installer; on macOS use upstream's ego lite app at https://lite.ego.app/"

# The script lives at <repo>/skills/ego-browser/scripts/install.sh.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
harness_dir="$repo_root/package/ego-browser"
shim_bin="$repo_root/package/ego-linux/bin/ego-browser.mjs"

[ -f "$harness_dir/package.json" ] ||
	die "cannot find the harness at $harness_dir — run this from a checkout of the fork"
[ -f "$shim_bin" ] ||
	die "cannot find the Linux shim at $shim_bin — this checkout looks like upstream, not the Linux fork"

command -v node >/dev/null 2>&1 || die "node is required (>= 22) but was not found on PATH"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || die "node >= 22 is required; found $(node -v)"

# The port drives a stock browser over CDP, so one of these must exist.
found_chrome=""
if [ -n "${EGO_LINUX_CHROME:-}" ] && [ -x "$EGO_LINUX_CHROME" ]; then
	found_chrome="$EGO_LINUX_CHROME"
else
	for candidate in $CHROME_CANDIDATES; do
		if command -v "$candidate" >/dev/null 2>&1; then
			found_chrome=$(command -v "$candidate")
			break
		fi
	done
fi
[ -n "$found_chrome" ] ||
	die "no Chrome/Chromium/Brave/Edge found on PATH (looked for: $CHROME_CANDIDATES). Install one, or set EGO_LINUX_CHROME to an absolute path."
log "Using browser: $found_chrome"

# CI=true is required, not cosmetic: the harness's prepare script runs
# `lefthook install`, which fails on any machine with a global core.hooksPath.
log "Building the upstream harness in $harness_dir ..."
(cd "$harness_dir" && CI=true npm ci && CI=true npm run build) ||
	die "harness build failed"

mkdir -p "$BIN_DIR"
ln -sf "$shim_bin" "$LINK_PATH"
log "Linked $LINK_PATH -> $shim_bin"

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) log "warning: $BIN_DIR is not on PATH. Add it, or run: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

"$LINK_PATH" --help >/dev/null 2>&1 || die "installed $LINK_PATH but it failed to run"

log ""
log "ego-browser is installed. Optional next steps (both touch user data, so they are not automatic):"
log "  ego-browser --import-chrome-profile    inherit your real logins"
log "  ego-browser --install-desktop-entry    add an app launcher icon"
