#!/bin/sh

set -eu

HOST_NAME="com.citrolabs.ego.gpu_mode"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
USER_DATA_DIR="${EGO_LITE_USER_DATA_DIR:-$HOME/Library/Application Support/Citro Labs/ego lite}"
NATIVE_HOST_DIR="${EGO_LITE_NATIVE_MESSAGING_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
INSTALL_DIR="$USER_DATA_DIR/GpuModeController"
MANIFEST_PATH="$NATIVE_HOST_DIR/$HOST_NAME.json"
LOCAL_STATE_PATH="$USER_DATA_DIR/Local State"
CONTROLLER_STATE_PATH="$USER_DATA_DIR/gpu_mode.json"
NODE_PATH=$(command -v node || true)

if [ -z "$NODE_PATH" ]; then
	printf '%s\n' "error: Node.js 22 or newer is required" >&2
	exit 1
fi

CURRENT_MODE=$(
	"$NODE_PATH" --input-type=module - \
		"$LOCAL_STATE_PATH" \
		"$CONTROLLER_STATE_PATH" \
		"$SCRIPT_DIR/native-host/mode-state.mjs" <<'EOF'
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [, , localStatePath, controllerStatePath, modeStatePath] = process.argv;
const { detectMode } = await import(pathToFileURL(modeStatePath));

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

const [localState, controllerState] = await Promise.all([
  readJson(localStatePath),
  readJson(controllerStatePath),
]);
process.stdout.write(detectMode(localState, controllerState.mode));
EOF
)

if [ "$CURRENT_MODE" != "normal" ]; then
	printf '%s\n' \
		"error: switch ego GPU Mode to Normal and let ego lite restart before uninstalling" >&2
	exit 1
fi

if [ -f "$MANIFEST_PATH" ]; then
	rm "$MANIFEST_PATH"
fi

for legacy_manifest in \
	"$USER_DATA_DIR/NativeMessagingHosts/$HOST_NAME.json" \
	"$HOME/Library/Application Support/Citro Labs/ego/NativeMessagingHosts/$HOST_NAME.json" \
	"$HOME/Library/Application Support/Chromium/NativeMessagingHosts/$HOST_NAME.json"; do
	if [ "$legacy_manifest" != "$MANIFEST_PATH" ] &&
		[ -f "$legacy_manifest" ]; then
		rm "$legacy_manifest"
	fi
done

if [ -d "$INSTALL_DIR" ]; then
	find "$INSTALL_DIR" -type f -delete
	find "$INSTALL_DIR" -depth -type d -empty -delete
fi

for state_file in \
	"$CONTROLLER_STATE_PATH" \
	"$USER_DATA_DIR/gpu_mode_error.log" \
	"$USER_DATA_DIR/gpu_mode_restart.lock"; do
	if [ -f "$state_file" ]; then
		rm "$state_file"
	fi
done

printf '%s\n' "Removed the ego GPU controller native host."
printf '%s\n' "Remove the unpacked extension from ego://extensions if it is still listed."
