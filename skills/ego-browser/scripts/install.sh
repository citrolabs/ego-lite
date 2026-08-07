#!/bin/sh
#v1.5 2026.06.04 17:16

set -eu

# Default package URL and installation paths.
DMG_URL_ARM64="https://cdn.ego.app/channel/egobrowser_npx_referral/setup/macos/arm64/egolite.dmg"
DMG_URL_X64="https://cdn.ego.app/channel/egobrowser_npx_referral/setup/macos/x64/egolite.dmg"
APP_NAME="ego lite"
APP_BUNDLE_NAME="$APP_NAME.app"
APP_PATH="/Applications/$APP_BUNDLE_NAME"
USER_APP_PATH="$HOME/Applications/$APP_BUNDLE_NAME"
EGO_BROWSER_HELPER_NAME="ego-browser"

# Linux: there is no .dmg to mount, so the CLI is linked from this repo instead.
LINUX_BIN_DIR="${EGO_LINUX_BIN_DIR:-$HOME/.local/bin}"
# Keep in sync with CHROME_CANDIDATES in package/ego-linux/src/chrome.mjs.
LINUX_CHROME_CANDIDATES="google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge"
LINUX_MIN_NODE_MAJOR=22

# Temporary directories created when mounting the DMG; cleaned up on exit.
TEMP_DIR=""
MOUNT_DIR=""
DMG_ATTACHED=""

log() {
	printf '%s\n' "$*" >&2
}

die() {
	log "error: $*"
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

select_dmg_url() {
	if [ "$(uname -m)" = "arm64" ]; then
		printf '%s\n' "$DMG_URL_ARM64"
	else
		printf '%s\n' "$DMG_URL_X64"
	fi
}

run_with_sudo_if_needed() {
	# Try without elevated privileges first; fall back to sudo to avoid unnecessary prompts.
	if "$@"; then
		return 0
	fi

	if [ "$(id -u)" -eq 0 ]; then
		return 1
	fi

	require_command sudo
	sudo "$@"
}

cleanup() {
	# Detach the DMG and remove the temp directory on success, failure, or Ctrl+C.
	if [ "$DMG_ATTACHED" = "1" ]; then
		if ! hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1; then
			log "warning: failed to detach $MOUNT_DIR"
		fi
		DMG_ATTACHED=""
	fi

	if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
		rm -rf "$TEMP_DIR" >/dev/null 2>&1 ||
			log "warning: failed to remove temporary directory: $TEMP_DIR"
	fi
}

strip_quarantine_attributes() {
	app_path="$1"
	run_with_sudo_if_needed xattr -dr com.apple.quarantine "$app_path" \
		>/dev/null 2>&1 || true
}

trap cleanup EXIT HUP INT TERM

find_ego_browser_in_app() {
	app_path="$1"

	[ -d "$app_path/Contents" ] || return 1

	# A Chromium app bundle may contain multiple versions; prefer the one under Current.
	for candidate in "$app_path"/Contents/Frameworks/*.framework/Versions/Current/Helpers/"$EGO_BROWSER_HELPER_NAME"; do
		if [ -x "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done

	# ego-browser may live in various locations inside the bundle; search under Contents.
	browser_path=$(
		find "$app_path/Contents" -type f -name "$EGO_BROWSER_HELPER_NAME" 2>/dev/null |
			while IFS= read -r candidate; do
				if [ -x "$candidate" ]; then
					printf '%s\n' "$candidate"
					break
				fi
			done
	)

	if [ -n "$browser_path" ]; then
		printf '%s\n' "$browser_path"
		return 0
	fi

	return 1
}

is_ego_lite_app() {
	app_path="$1"

	# The directory exists and contains a working ego-browser — ego lite is considered installed.
	[ -d "$app_path" ] || return 1
	find_ego_browser_in_app "$app_path" >/dev/null
}

find_ego_lite_app() {
	for app_path in "$APP_PATH" "$USER_APP_PATH"; do
		if is_ego_lite_app "$app_path"; then
			printf '%s\n' "$app_path"
			return 0
		fi
	done

	for apps_dir in "$(dirname "$APP_PATH")" "$(dirname "$USER_APP_PATH")"; do
		[ -d "$apps_dir" ] || continue

		app_path=$(
			find "$apps_dir" -maxdepth 1 -type d -iname "$APP_BUNDLE_NAME" 2>/dev/null |
				while IFS= read -r candidate; do
					if is_ego_lite_app "$candidate"; then
						printf '%s\n' "$candidate"
						break
					fi
				done
		)
		if [ -n "$app_path" ]; then
			printf '%s\n' "$app_path"
			return 0
		fi
	done

	return 1
}

install_ego_lite() {
	require_command curl
	require_command hdiutil

	# Download and mount the DMG in an isolated temp directory to avoid polluting the CWD.
	temp_base_dir=${TMPDIR:-/tmp}
	temp_base_dir=${temp_base_dir%/}
	TEMP_DIR=$(mktemp -d "$temp_base_dir/ego-lite-install.XXXXXX")
	MOUNT_DIR="$TEMP_DIR/mount"
	dmg_path="$TEMP_DIR/egolite.dmg"
	dmg_url=$(select_dmg_url)
	mkdir -p "$MOUNT_DIR"

	log "$APP_NAME is not installed. Downloading $dmg_url ..."
	curl -fL --retry 3 --output "$dmg_path" "$dmg_url" ||
		die "failed to download $APP_NAME from $dmg_url"

	log "Mounting installer ..."
	hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$MOUNT_DIR" \
		>/dev/null
	DMG_ATTACHED="1"

	# Handle DMGs that contain the app bundle directly.
	app_in_dmg=$(
		find "$MOUNT_DIR" -maxdepth 2 \
			-type d -iname "$APP_BUNDLE_NAME" |
			head -n 1
	)

	if [ -n "$app_in_dmg" ]; then
		staged_app="$TEMP_DIR/$APP_BUNDLE_NAME"

		log "Installing $APP_NAME to $APP_PATH ..."
		ditto "$app_in_dmg" "$staged_app" ||
			die "failed to stage $APP_NAME from installer"
		find_ego_browser_in_app "$staged_app" >/dev/null ||
			die "installed $APP_NAME does not contain $EGO_BROWSER_HELPER_NAME"

		# Strip quarantine attributes to prevent Gatekeeper from blocking the first launch.
		log "Removing quarantine attributes from $APP_NAME ..."
		xattr -dr com.apple.quarantine "$staged_app" \
			>/dev/null 2>&1 || true

		if [ -d "$APP_PATH" ]; then
			run_with_sudo_if_needed rm -rf "$APP_PATH" ||
				die "failed to replace existing $APP_PATH"
		fi
		run_with_sudo_if_needed mv "$staged_app" "$APP_PATH" ||
			die "failed to move $APP_NAME to $APP_PATH"
		return 0
	fi

	# Fall back to pkg installer if the DMG contains a .pkg instead of an app bundle.
	pkg_in_dmg=$(
		find "$MOUNT_DIR" -maxdepth 2 -type f -name "*.pkg" |
			head -n 1
	)

	if [ -n "$pkg_in_dmg" ]; then
		log "Installing $APP_NAME package ..."
		run_with_sudo_if_needed installer -pkg "$pkg_in_dmg" -target / ||
			die "failed to install $APP_NAME package"
		return 0
	fi

	die "cannot find $APP_NAME app or pkg in mounted DMG"
}

main_macos() {
	# Install first if not present; otherwise use the ego-browser bundled inside the app.
	installed_app_path=$(find_ego_lite_app || true)
	if [ -z "$installed_app_path" ]; then
		install_ego_lite
		installed_app_path=$(find_ego_lite_app || true)
		[ -n "$installed_app_path" ] ||
			die "$APP_NAME install completed, but app was not found"
	fi

	strip_quarantine_attributes "$installed_app_path"
	cleanup

	log "Launching $APP_NAME ..."
	exec open "$installed_app_path"
}

# Linux has no ego lite app bundle. The same harness under package/ego-browser
# drives a stock Chrome/Chromium over CDP through the shim in package/ego-linux,
# so the install is a build plus a symlink rather than a download.
main_linux() {
	script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
	repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
	harness_dir="$repo_root/package/ego-browser"
	shim_bin="$repo_root/package/ego-linux/bin/ego-browser.mjs"
	link_path="$LINUX_BIN_DIR/$EGO_BROWSER_HELPER_NAME"

	[ -f "$harness_dir/package.json" ] ||
		die "cannot find the harness at $harness_dir — run this script from a checkout of this repository"
	[ -f "$shim_bin" ] ||
		die "cannot find the Linux shim at $shim_bin — this checkout predates Linux support"

	require_command node
	node_major=$(node -p 'process.versions.node.split(".")[0]')
	[ "$node_major" -ge "$LINUX_MIN_NODE_MAJOR" ] ||
		die "node >= $LINUX_MIN_NODE_MAJOR is required; found $(node -v)"

	# The port drives a stock browser over CDP, so one of these must exist.
	found_chrome=""
	if [ -n "${EGO_LINUX_CHROME:-}" ] && [ -x "${EGO_LINUX_CHROME:-}" ]; then
		found_chrome="$EGO_LINUX_CHROME"
	else
		for candidate in $LINUX_CHROME_CANDIDATES; do
			if command -v "$candidate" >/dev/null 2>&1; then
				found_chrome=$(command -v "$candidate")
				break
			fi
		done
	fi
	[ -n "$found_chrome" ] ||
		die "no Chrome/Chromium/Brave/Edge found on PATH (looked for: $LINUX_CHROME_CANDIDATES). Install one, or set EGO_LINUX_CHROME to an absolute path."
	log "Using browser: $found_chrome"

	# CI=true is required, not cosmetic: the harness's prepare script runs
	# `lefthook install`, which fails on any machine with a global core.hooksPath.
	log "Building the harness in $harness_dir ..."
	(cd "$harness_dir" && CI=true npm ci && CI=true npm run build) ||
		die "harness build failed"

	mkdir -p "$LINUX_BIN_DIR"
	ln -sf "$shim_bin" "$link_path"
	log "Linked $link_path -> $shim_bin"

	case ":$PATH:" in
	*":$LINUX_BIN_DIR:"*) ;;
	*) log "warning: $LINUX_BIN_DIR is not on PATH. Add it, or run: export PATH=\"$LINUX_BIN_DIR:\$PATH\"" ;;
	esac

	"$link_path" --help >/dev/null 2>&1 ||
		die "installed $link_path but it failed to run"

	log ""
	log "ego-browser is installed. Optional next steps (both touch user data, so they are not automatic):"
	log "  ego-browser --import-chrome-profile    inherit your real logins"
	log "  ego-browser --install-desktop-entry    add an app launcher icon"
}

# Pick the flow by OS rather than refusing everything that is not macOS. The
# cleanup trap above is a no-op on Linux: nothing sets TEMP_DIR or DMG_ATTACHED
# on that path.
main() {
	case "$(uname -s)" in
	Darwin) main_macos ;;
	Linux) main_linux ;;
	*) die "unsupported platform: $(uname -s) (supported: macOS, Linux)" ;;
	esac
}

main
