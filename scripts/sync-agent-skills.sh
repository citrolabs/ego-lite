#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

SOURCE_ARG="skills"
TARGET_ARG=".agents/skills"
DRY_RUN=0
REQUESTED_SKILLS=()

usage() {
  cat <<'USAGE'
Usage: scripts/sync-agent-skills.sh [options] [skill ...]

Sync reviewed skill source directories into the local agent skills folder.

Options:
  --source DIR   Source skills directory. Defaults to skills
  --target DIR   Target skills directory. Defaults to .agents/skills
  --dry-run      Print planned sync operations without writing files
  -h, --help     Show this help

For agent-browser, runtime site experience under reference/sites is preserved.

Examples:
  scripts/sync-agent-skills.sh
  scripts/sync-agent-skills.sh agent-browser
  scripts/sync-agent-skills.sh --target .agent/skills agent-browser
USAGE
}

die() {
  printf 'sync-agent-skills: %s\n' "$*" >&2
  exit 1
}

resolve_path() {
  local value="$1"

  case "$value" in
    /*) printf '%s\n' "$value" ;;
    *) printf '%s\n' "$ROOT_DIR/$value" ;;
  esac
}

require_option_value() {
  local option="$1"
  local value="${2:-}"

  if [[ -z "$value" || "$value" == --* ]]; then
    die "$option requires a directory value"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      require_option_value "$1" "${2:-}"
      SOURCE_ARG="$2"
      shift 2
      ;;
    --target)
      require_option_value "$1" "${2:-}"
      TARGET_ARG="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        REQUESTED_SKILLS+=("$1")
        shift
      done
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      REQUESTED_SKILLS+=("$1")
      shift
      ;;
  esac
done

SOURCE_DIR="$(resolve_path "$SOURCE_ARG")"
TARGET_DIR="$(resolve_path "$TARGET_ARG")"

[[ -d "$SOURCE_DIR" ]] || die "Source directory does not exist: $SOURCE_DIR"

SKILLS=()
if [[ ${#REQUESTED_SKILLS[@]} -gt 0 ]]; then
  SKILLS=("${REQUESTED_SKILLS[@]}")
else
  # Only directories with SKILL.md are agent skills. Sorting keeps output stable.
  while IFS= read -r skill_path; do
    [[ -f "$skill_path/SKILL.md" ]] || continue
    SKILLS+=("$(basename "$skill_path")")
  done < <(find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort)
fi

[[ ${#SKILLS[@]} -gt 0 ]] || die "No skills found under: $SOURCE_DIR"

if ! command -v rsync >/dev/null 2>&1; then
  die "rsync is required to mirror skill directories"
fi

for skill in "${SKILLS[@]}"; do
  SOURCE_SKILL_DIR="$SOURCE_DIR/$skill"
  TARGET_SKILL_DIR="$TARGET_DIR/$skill"

  [[ -d "$SOURCE_SKILL_DIR" ]] || die "Missing skill source: $SOURCE_SKILL_DIR"
  [[ -f "$SOURCE_SKILL_DIR/SKILL.md" ]] || die "Missing SKILL.md in: $SOURCE_SKILL_DIR"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'Would sync %s: %s -> %s\n' "$skill" "$SOURCE_SKILL_DIR" "$TARGET_SKILL_DIR"
    continue
  fi

  mkdir -p "$TARGET_SKILL_DIR"

  RSYNC_ARGS=(-a --delete --exclude='.DS_Store')
  if [[ "$skill" == "agent-browser" ]]; then
    # Site experience is maintained at runtime in the installed skill root.
    # Preserve it when syncing reviewed source code and documentation.
    RSYNC_ARGS+=(--exclude='reference/sites/***')
  fi

  # Mirror reviewed source while preserving runtime-owned data where applicable.
  rsync "${RSYNC_ARGS[@]}" "$SOURCE_SKILL_DIR/" "$TARGET_SKILL_DIR/"
  printf 'Synced %s: %s -> %s\n' "$skill" "$SOURCE_SKILL_DIR" "$TARGET_SKILL_DIR"
done
