#!/bin/sh

set -eu

HOST_NAME="com.citrolabs.ego.gpu_mode"
EXTENSION_ID="iemmjhekmkccaghebaammoflapofhaik"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
USER_DATA_DIR="${EGO_LITE_USER_DATA_DIR:-$HOME/Library/Application Support/Citro Labs/ego lite}"
NATIVE_HOST_DIR="${EGO_LITE_NATIVE_MESSAGING_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
INSTALL_DIR="$USER_DATA_DIR/GpuModeController"
EXTENSION_DIR="$INSTALL_DIR/extension"
HOST_DIR="$INSTALL_DIR/native-host"
MANIFEST_PATH="$NATIVE_HOST_DIR/$HOST_NAME.json"
NODE_PATH=$(command -v node || true)

if [ "$(uname -s)" != "Darwin" ]; then
	printf '%s\n' "error: the ego GPU controller currently supports macOS only" >&2
	exit 1
fi

if [ -z "$NODE_PATH" ]; then
	printf '%s\n' "error: Node.js 22 or newer is required" >&2
	exit 1
fi

NODE_MAJOR=$("$NODE_PATH" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
	printf '%s\n' "error: Node.js 22 or newer is required" >&2
	exit 1
fi

mkdir -p "$EXTENSION_DIR" "$HOST_DIR" "$NATIVE_HOST_DIR"
cp "$SCRIPT_DIR"/extension/* "$EXTENSION_DIR/"
cp "$SCRIPT_DIR"/native-host/*.mjs "$HOST_DIR/"

cat >"$HOST_DIR/host" <<EOF
#!/bin/sh
exec "$NODE_PATH" "$HOST_DIR/host.mjs"
EOF
chmod 755 "$HOST_DIR/host"

"$NODE_PATH" - "$MANIFEST_PATH" "$HOST_DIR/host" "$HOST_NAME" "$EXTENSION_ID" <<'EOF'
import { writeFileSync } from "node:fs";

const [, , manifestPath, hostPath, hostName, extensionId] = process.argv;
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: hostName,
      description: "Switch ego lite GPU compatibility modes",
      path: hostPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
EOF

for legacy_manifest in \
	"$USER_DATA_DIR/NativeMessagingHosts/$HOST_NAME.json" \
	"$HOME/Library/Application Support/Citro Labs/ego/NativeMessagingHosts/$HOST_NAME.json" \
	"$HOME/Library/Application Support/Chromium/NativeMessagingHosts/$HOST_NAME.json"; do
	if [ "$legacy_manifest" != "$MANIFEST_PATH" ] &&
		[ -f "$legacy_manifest" ]; then
		rm "$legacy_manifest"
	fi
done

printf '%s\n' \
	"Installed the native host." \
	"Extension directory:" \
	"$EXTENSION_DIR" \
	"" \
	"Open ego://extensions, enable Developer mode, choose Load unpacked, and select that directory." \
	"After this one-time setup, GPU modes are changed from the ego toolbar."

open -a "ego lite" "ego://extensions/" >/dev/null 2>&1 || true
