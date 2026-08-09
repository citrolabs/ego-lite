#!/bin/sh

set -eu

APP_NAME="ego lite"
SYSTEM_APP_PATH="/Applications/$APP_NAME.app"
USER_APP_PATH="$HOME/Applications/$APP_NAME.app"

usage() {
	cat <<'EOF'
Usage:
  launch-gpu-mode.sh [normal|balanced|low-power|software]

Modes:
  normal      Launch ego lite without graphics overrides.
  balanced    Disable Skia Graphite while keeping WebGL available.
  low-power   Disable WebGL for the largest GPU reduction.
  software    Disable GPU acceleration for troubleshooting only.

The mode defaults to EGO_LITE_GPU_MODE, or balanced when unset.
Quit ego lite before running this script. Graphics flags only apply at startup.
EOF
}

log() {
	printf '%s\n' "$*" >&2
}

die() {
	log "error: $*"
	exit 1
}

find_app() {
	if [ -n "${EGO_LITE_APP_PATH:-}" ]; then
		[ -d "$EGO_LITE_APP_PATH" ] ||
			die "ego lite app was not found at $EGO_LITE_APP_PATH"
		printf '%s\n' "$EGO_LITE_APP_PATH"
		return
	fi

	for app_path in "$SYSTEM_APP_PATH" "$USER_APP_PATH"; do
		if [ -d "$app_path" ]; then
			printf '%s\n' "$app_path"
			return
		fi
	done

	die "ego lite is not installed in /Applications or ~/Applications"
}

mode="${1:-${EGO_LITE_GPU_MODE:-balanced}}"

case "$mode" in
	-h | --help)
		usage
		exit 0
		;;
esac

[ "$#" -le 1 ] || {
	usage >&2
	exit 2
}

[ "$(uname -s)" = "Darwin" ] ||
	die "GPU compatibility modes currently support macOS only"

app_path=$(find_app)

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
	die "ego lite is already running; quit it completely and retry"
fi

case "$mode" in
	normal)
		log "Launching ego lite in normal graphics mode."
		exec open "$app_path"
		;;
	balanced)
		log "Launching ego lite with Skia Graphite disabled; WebGL remains available."
		set -- --disable-features=SkiaGraphite
		;;
	low-power)
		log "Launching ego lite with WebGL disabled; WebGL pages and visual agent overlays may be unavailable."
		set -- --disable-webgl
		;;
	software)
		log "Launching ego lite with GPU acceleration disabled; use this mode for troubleshooting only."
		set -- --disable-gpu
		;;
	*)
		usage >&2
		exit 2
		;;
esac

exec open -n "$app_path" --args "$@"
