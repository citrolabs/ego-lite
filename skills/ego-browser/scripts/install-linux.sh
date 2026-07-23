#!/usr/bin/env bash
# Install ego-browser Linux host (ego-shaped OSS host — not the Citro/macOS app).
#
# This script builds the monorepo packages and places an `ego-browser` shim on PATH.
# It does NOT download the macOS DMG from cdn.ego.app.
#
# Usage (from anywhere; resolves repo root relative to this script):
#   bash skills/ego-browser/scripts/install-linux.sh
#   bash skills/ego-browser/scripts/install-linux.sh --doctor   # install + force doctor
#
# Requirements:
#   - Linux (or WSL with Linux-side Chrome/Chromium)
#   - Node.js ≥ 22 and npm
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EGO_BROWSER_PKG="$REPO_ROOT/package/ego-browser"
EGO_LINUX_HOST_PKG="$REPO_ROOT/package/ego-linux-host"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ego-lite"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ego-lite"
SHIM_TARGET="$EGO_LINUX_HOST_PKG/bin/ego-browser.mjs"
SHIM_LINK="$BIN_DIR/ego-browser"
RUN_DOCTOR=1

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

usage() {
  cat >&2 <<'EOF'
Usage: install-linux.sh [--doctor|--no-doctor] [-h|--help]

  Install the ego-shaped Linux host for ego-browser (not the Citro macOS app).

  --doctor      Run `ego-browser --doctor` after install (default)
  --no-doctor   Skip the doctor smoke check
  -h, --help    Show this help
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --doctor)
        RUN_DOCTOR=1
        shift
        ;;
      --no-doctor)
        RUN_DOCTOR=0
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1 (try --help)"
        ;;
    esac
  done
}

require_linux() {
  local os
  os="$(uname -s)"
  [ "$os" = "Linux" ] || die "this script only supports Linux (got uname -s=$os). On macOS use scripts/install.sh (Citro DMG)."
}

require_node22() {
  require_command node
  require_command npm
  local version major
  version="$(node -v 2>/dev/null || true)"
  version="${version#v}"
  major="${version%%.*}"
  case "$major" in
    '' | *[!0-9]*)
      die "could not parse Node version from: $(node -v 2>&1 || true)"
      ;;
  esac
  if [ "$major" -lt 22 ]; then
    die "Node.js ≥ 22 required (found v$version). Install a newer Node and retry."
  fi
  log "Node $(node -v) OK"
}

build_packages() {
  [ -d "$EGO_BROWSER_PKG" ] || die "missing package: $EGO_BROWSER_PKG"
  [ -d "$EGO_LINUX_HOST_PKG" ] || die "missing package: $EGO_LINUX_HOST_PKG"
  [ -f "$SHIM_TARGET" ] || die "missing CLI entry: $SHIM_TARGET"

  log "Building package/ego-browser ..."
  (
    cd "$EGO_BROWSER_PKG"
    # Skip lefthook prepare hook outside the intentional git setup.
    CI=true npm ci
    npm run build
  )

  log "Building package/ego-linux-host ..."
  (
    cd "$EGO_LINUX_HOST_PKG"
    CI=true npm ci
    npm run build
  )
}

create_dirs_and_symlink() {
  mkdir -p "$BIN_DIR" "$DATA_DIR" "$CONFIG_DIR"
  chmod 700 "$DATA_DIR" 2>/dev/null || true

  chmod +x \
    "$EGO_LINUX_HOST_PKG/bin/ego-browser.mjs" \
    "$EGO_LINUX_HOST_PKG/bin/ego-linux-hostd.mjs"

  ln -sfn "$SHIM_TARGET" "$SHIM_LINK"
  log "Linked $SHIM_LINK -> $SHIM_TARGET"
  log "Data dir:   $DATA_DIR"
  log "Config dir: $CONFIG_DIR"
}

detect_chrome() {
  if [ -n "${EGO_CHROME_PATH:-}" ]; then
    if [ -x "$EGO_CHROME_PATH" ]; then
      log "Chrome: EGO_CHROME_PATH=$EGO_CHROME_PATH"
      return 0
    fi
    log "warning: EGO_CHROME_PATH is set but not executable: $EGO_CHROME_PATH"
  fi

  local candidate found=""
  for candidate in \
    google-chrome-stable \
    google-chrome \
    chromium \
    chromium-browser \
    /usr/bin/google-chrome \
    /usr/bin/google-chrome-stable \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    /opt/google/chrome/chrome \
    /snap/bin/chromium
  do
    if [[ "$candidate" == /* ]]; then
      if [ -x "$candidate" ]; then
        found="$candidate"
        break
      fi
    else
      if command -v "$candidate" >/dev/null 2>&1; then
        found="$(command -v "$candidate")"
        break
      fi
    fi
  done

  if [ -n "$found" ]; then
    log "Chrome: found $found"
    return 0
  fi

  cat >&2 <<'EOF'
warning: Chrome/Chromium not found on PATH.

  Install a Linux-side browser (WSL: not Windows chrome.exe), for example:
    # Debian/Ubuntu
    sudo apt-get install -y chromium-browser
    # or Google Chrome from https://www.google.com/chrome/
  Then set EGO_CHROME_PATH if the binary is non-standard:
    export EGO_CHROME_PATH=/path/to/chrome

  Headed mode needs a display (native Linux or WSLg). For headless:
    export EGO_HEADLESS=1
EOF
  return 0
}

check_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      log "PATH: $BIN_DIR is already on PATH"
      ;;
    *)
      cat >&2 <<EOF
warning: $BIN_DIR is not on PATH in this shell.

  Add it for this session:
    export PATH="\$HOME/.local/bin:\$PATH"

  Persist it in ~/.bashrc or ~/.zshrc:
    export PATH="\$HOME/.local/bin:\$PATH"
EOF
      # Ensure doctor / post-checks work in this script.
      export PATH="$BIN_DIR:$PATH"
      ;;
  esac
}

run_doctor() {
  if [ "$RUN_DOCTOR" -eq 0 ]; then
    log "Skipping ego-browser --doctor (--no-doctor)"
    return 0
  fi

  log "Running ego-browser --doctor ..."
  if command -v ego-browser >/dev/null 2>&1; then
    ego-browser --doctor || log "warning: ego-browser --doctor exited non-zero (Chrome/display may be missing)"
  else
    # Fallback if PATH still odd
    node "$SHIM_TARGET" --doctor || log "warning: ego-browser --doctor exited non-zero (Chrome/display may be missing)"
  fi
}

main() {
  parse_args "$@"
  require_linux
  require_node22
  build_packages
  create_dirs_and_symlink
  detect_chrome
  check_path
  run_doctor

  cat >&2 <<EOF

Install complete (ego-shaped Linux host — not Citro/macOS ego lite).

  command:  $(command -v ego-browser 2>/dev/null || echo "$SHIM_LINK")
  host:     package/ego-linux-host
  harness:  package/ego-browser

Next:
  command -v ego-browser
  ego-browser --doctor
  ego-browser nodejs <<'EOFJS'
console.log('ego-browser ready')
EOFJS

For headed browsing under WSL, prefer WSLg (DISPLAY set). Headless:
  EGO_HEADLESS=1 ego-browser ...
EOF
}

main "$@"
