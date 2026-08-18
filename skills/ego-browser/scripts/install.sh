#!/bin/sh
#v1.6 2026.08.17

set -eu

# Default package URL and installation paths (macOS).
DMG_URL_ARM64="https://cdn.ego.app/setup/macos/arm64/egolite-fHoqgZ74bOEM.dmg"
DMG_URL_X64="https://cdn.ego.app/setup/macos/x64/egolite-fHoqgZ74bOEM.dmg"
APP_NAME="ego lite"
APP_BUNDLE_NAME="$APP_NAME.app"
APP_PATH="/Applications/$APP_BUNDLE_NAME"
USER_APP_PATH="$HOME/Applications/$APP_BUNDLE_NAME"
EGO_BROWSER_HELPER_NAME="ego-browser"

# Temporary directories created when mounting the DMG; cleaned up on exit.
TEMP_DIR=""
MOUNT_DIR=""
DMG_ATTACHED=""

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

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

confirm() {
	# Interactive yes/no prompt. Defaults to "no" when there's no tty to prompt on,
	# unless the caller opted into non-interactive installs.
	question="$1"

	if [ "${EGO_BROWSER_ASSUME_YES:-}" = "1" ]; then
		return 0
	fi
	if [ ! -t 0 ]; then
		log "note: non-interactive shell, skipping prompt: $question"
		log "      (set EGO_BROWSER_ASSUME_YES=1 to auto-confirm)"
		return 1
	fi

	printf '%s [y/N] ' "$question" >&2
	read -r reply
	case "$reply" in
	[Yy]*) return 0 ;;
	*) return 1 ;;
	esac
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

trap cleanup EXIT HUP INT TERM

# ---------------------------------------------------------------------------
# macOS
# ---------------------------------------------------------------------------

select_dmg_url() {
	if [ "$(uname -m)" = "arm64" ]; then
		printf '%s\n' "$DMG_URL_ARM64"
	else
		printf '%s\n' "$DMG_URL_X64"
	fi
}

strip_quarantine_attributes() {
	app_path="$1"
	run_with_sudo_if_needed xattr -dr com.apple.quarantine "$app_path" \
		>/dev/null 2>&1 || true
}

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

main_darwin() {
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

# ---------------------------------------------------------------------------
# Linux
# ---------------------------------------------------------------------------

detect_linux_pkg_manager() {
	if command -v apt-get >/dev/null 2>&1; then
		printf 'apt\n'
	elif command -v dnf >/dev/null 2>&1; then
		printf 'dnf\n'
	elif command -v pacman >/dev/null 2>&1; then
		printf 'pacman\n'
	elif command -v zypper >/dev/null 2>&1; then
		printf 'zypper\n'
	else
		return 1
	fi
}

find_chrome_binary() {
	for bin in google-chrome google-chrome-stable chromium-browser chromium; do
		if command -v "$bin" >/dev/null 2>&1; then
			command -v "$bin"
			return 0
		fi
	done
	return 1
}

install_chrome_linux() {
	pkg_manager="$1"

	case "$pkg_manager" in
	apt)
		run_with_sudo_if_needed apt-get update
		run_with_sudo_if_needed apt-get install -y chromium ||
			run_with_sudo_if_needed apt-get install -y chromium-browser
		;;
	dnf)
		run_with_sudo_if_needed dnf install -y chromium
		;;
	pacman)
		run_with_sudo_if_needed pacman -Sy --noconfirm chromium
		;;
	zypper)
		run_with_sudo_if_needed zypper install -y chromium
		;;
	*)
		die "unsupported package manager: $pkg_manager"
		;;
	esac
}

warn_wayland() {
	if [ -n "${WAYLAND_DISPLAY:-}" ]; then
		log "note: Wayland session detected (WAYLAND_DISPLAY=$WAYLAND_DISPLAY)."
		log "      If the browser fails to open natively under Wayland, launch"
		log "      Chrome/Chromium with: --ozone-platform-hint=auto"
	fi
}

ensure_chrome_linux() {
	chrome_bin=$(find_chrome_binary || true)
	if [ -n "$chrome_bin" ] && "$chrome_bin" --version >/dev/null 2>&1; then
		log "Found browser: $chrome_bin"
		return 0
	fi

	log "No working google-chrome, chromium-browser, or chromium binary found."
	pkg_manager=$(detect_linux_pkg_manager || true)
	if [ -z "$pkg_manager" ]; then
		die "no supported package manager (apt/dnf/pacman/zypper) found; install Chrome or Chromium manually and re-run"
	fi

	if ! confirm "Install chromium via $pkg_manager now?"; then
		die "a Chrome or Chromium browser is required; install one manually and re-run"
	fi

	install_chrome_linux "$pkg_manager"

	chrome_bin=$(find_chrome_binary || true)
	if [ -z "$chrome_bin" ] || ! "$chrome_bin" --version >/dev/null 2>&1; then
		die "chromium install completed, but no working browser binary was found on PATH (on Ubuntu, 'apt install chromium' may only provide a snap-forwarding stub; install Google Chrome from https://www.google.com/chrome/ or 'sudo snap install chromium' instead)"
	fi
	log "Found browser: $chrome_bin"
}

find_ego_browser_package() {
	# The CLI package lives at package/ego-browser in the ego-lite repo, three
	# directories up from this script (skills/ego-browser/scripts).
	candidate="$SCRIPT_DIR/../../../package/ego-browser"
	if [ -f "$candidate/package.json" ]; then
		(CDPATH= cd -- "$candidate" && pwd)
		return 0
	fi
	return 1
}

build_ego_browser_package() {
	pkg_dir="$1"
	require_command node
	require_command npm

	needs_build=0
	if [ ! -f "$pkg_dir/dist/out/index.js" ]; then
		needs_build=1
	elif [ "$pkg_dir/src" -nt "$pkg_dir/dist/out/index.js" ] 2>/dev/null; then
		needs_build=1
	elif [ "$pkg_dir/package.json" -nt "$pkg_dir/dist/out/index.js" ] 2>/dev/null; then
		needs_build=1
	fi
	if [ "$needs_build" -eq 1 ]; then
		log "Building the ego-browser CLI (one-time) ..."
		if [ ! -d "$pkg_dir/node_modules" ]; then
			(cd "$pkg_dir" && npm ci) || die "npm ci failed in $pkg_dir"
		fi
		(cd "$pkg_dir" && npm run build) || die "npm run build failed in $pkg_dir"
	fi

	[ -f "$pkg_dir/dist/out/index.js" ] ||
		die "build finished but $pkg_dir/dist/out/index.js is missing"
}

create_linux_shim() {
	pkg_dir="$1"
	bin_dir="$HOME/.local/bin"
	shim_path="$bin_dir/$EGO_BROWSER_HELPER_NAME"

	mkdir -p "$bin_dir"
	cat >"$shim_path" <<SHIM
#!/bin/sh
exec node "$pkg_dir/dist/out/index.js" "\$@"
SHIM
	chmod +x "$shim_path"

	printf '%s\n' "$shim_path"
}

main_linux() {
	warn_wayland
	ensure_chrome_linux

	pkg_dir=$(find_ego_browser_package) ||
		die "could not find package/ego-browser next to this skill; run this script from a clone of the ego-lite repo"

	build_ego_browser_package "$pkg_dir"
	shim_path=$(create_linux_shim "$pkg_dir")

	log "Verifying the ego-browser CLI ..."
	node "$pkg_dir/dist/out/index.js" --help ||
		die "ego-browser CLI failed to run; check your Node.js installation"

	log "Installed $EGO_BROWSER_HELPER_NAME to $shim_path"
	case ":$PATH:" in
	*":$HOME/.local/bin:"*) : ;;
	*) log "warning: $HOME/.local/bin is not on PATH; add it to your shell profile" ;;
	esac
}

# ---------------------------------------------------------------------------

main() {
	case "$(uname -s)" in
	Darwin) main_darwin ;;
	Linux) main_linux ;;
	*) die "unsupported OS: $(uname -s) (supported: Darwin, Linux)" ;;
	esac
}

main
