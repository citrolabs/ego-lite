#!/usr/bin/env python3
"""Find saved Agent Browser experience for the current or target site."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPT_DIR.parent
DEFAULT_SITES_DIR = SKILL_ROOT / "reference" / "sites"

DANGEROUS_PATTERNS = [
    "rm -rf",
    "git reset --hard",
    "os.remove",
    "shutil.rmtree",
    ".unlink(",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Return a YAML index of saved site experience for Agent Browser."
    )
    parser.add_argument("--url", help="Target URL. Defaults to `agent-browser get url`.")
    parser.add_argument(
        "--sites-dir",
        type=Path,
        default=DEFAULT_SITES_DIR,
        help="Directory containing site experience folders.",
    )
    return parser.parse_args()


def yaml_scalar(value: object) -> str:
    text = "" if value is None else str(value)
    if text == "":
        return '""'
    if any(char in text for char in [": ", "#", "\n", '"']) or text.strip() != text:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def emit_yaml(data: dict[str, object]) -> str:
    lines: list[str] = []

    def emit_value(key: str, value: object, indent: int) -> None:
        prefix = " " * indent
        if isinstance(value, dict):
            lines.append(f"{prefix}{key}:")
            for child_key, child_value in value.items():
                emit_value(child_key, child_value, indent + 2)
        elif isinstance(value, list):
            lines.append(f"{prefix}{key}:")
            for item in value:
                if isinstance(item, dict):
                    lines.append(f"{prefix}  - {next(iter(item))}: {yaml_scalar(next(iter(item.values())))}")
                    for child_key, child_value in list(item.items())[1:]:
                        emit_value(child_key, child_value, indent + 4)
                else:
                    lines.append(f"{prefix}  - {yaml_scalar(item)}")
        else:
            lines.append(f"{prefix}{key}: {yaml_scalar(value)}")

    for key, value in data.items():
        emit_value(key, value, 0)
    return "\n".join(lines) + "\n"


def output(data: dict[str, object], exit_code: int = 0) -> int:
    sys.stdout.write(emit_yaml(data))
    return exit_code


def current_browser_url() -> tuple[str | None, str | None]:
    result = subprocess.run(
        ["agent-browser", "get", "url"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        return None, result.stderr.strip() or "agent-browser get url failed"
    return result.stdout.strip(), None


def host_from_url(url: str) -> str:
    parse_target = url if "://" in url else f"https://{url}"
    parsed = urlparse(parse_target)
    return (parsed.hostname or "").lower()


def read_frontmatter(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}

    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return {}

    try:
        raw = text.split("---", 2)[1]
    except IndexError:
        return {}

    data: dict[str, object] = {}
    current_list_key: str | None = None
    for raw_line in raw.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if current_list_key and stripped.startswith("- "):
            data.setdefault(current_list_key, [])
            list_value = data[current_list_key]
            if isinstance(list_value, list):
                list_value.append(strip_quotes(stripped[2:].strip()))
            continue
        current_list_key = None
        if ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value:
            data[key] = strip_quotes(value)
        else:
            data[key] = []
            current_list_key = key
    return data


def read_python_comment_metadata(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}

    lines: list[str] = []
    in_block = False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if not stripped.startswith("#"):
            if in_block:
                break
            continue
        comment = stripped[1:].strip()
        if comment == "---":
            if in_block:
                return parse_metadata_lines(lines)
            in_block = True
            continue
        if in_block:
            lines.append(comment)
    return {}


def parse_metadata_lines(lines: list[str]) -> dict[str, object]:
    data: dict[str, object] = {}
    current_list_key: str | None = None
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if current_list_key and stripped.startswith("- "):
            data.setdefault(current_list_key, [])
            list_value = data[current_list_key]
            if isinstance(list_value, list):
                list_value.append(strip_quotes(stripped[2:].strip()))
            continue
        current_list_key = None
        if ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value:
            data[key] = strip_quotes(value)
        else:
            data[key] = []
            current_list_key = key
    return data


def strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def display_base_for_sites_dir(sites_dir: Path) -> Path:
    resolved = sites_dir.resolve()
    if resolved.name == "sites" and resolved.parent.name == "reference":
        return resolved.parent.parent
    return resolved.parent


def display_path(path: Path, base: Path) -> str:
    try:
        return path.resolve().relative_to(base.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def site_hosts(site_dir: Path, site_meta: dict[str, object]) -> set[str]:
    hosts = {site_dir.name.lower()}
    frontmatter_hosts = site_meta.get("hosts", [])
    if isinstance(frontmatter_hosts, list):
        hosts.update(str(host).lower() for host in frontmatter_hosts)
    return hosts


def has_required_text(meta: dict[str, object], *keys: str) -> bool:
    for key in keys:
        value = meta.get(key)
        if not isinstance(value, str) or not value.strip():
            return False
    return True


def python_tool_is_indexable(path: Path) -> bool:
    meta = read_python_comment_metadata(path)
    if not has_required_text(meta, "name", "description"):
        return False
    inputs = meta.get("inputs")
    if inputs is not None and not isinstance(inputs, list):
        return False

    try:
        source = path.read_text(encoding="utf-8")
        compile(source, str(path), "exec")
    except (OSError, SyntaxError, UnicodeDecodeError):
        return False

    return not any(pattern in source for pattern in DANGEROUS_PATTERNS)


def workflow_tool_references_are_indexable(meta: dict[str, object], base: Path) -> bool:
    tool_refs = meta.get("tools")
    if not isinstance(tool_refs, list) or not tool_refs:
        return False

    for tool_ref in tool_refs:
        if not isinstance(tool_ref, str) or not tool_ref.strip():
            return False
        if tool_ref.startswith("/") or ".." in Path(tool_ref).parts:
            return False
        target = (base / tool_ref).resolve()
        if not is_under(target, base):
            return False
        if target.suffix != ".py" or "/tools/" not in target.as_posix():
            return False
        if not target.exists() or not python_tool_is_indexable(target):
            return False
    return True


def markdown_index_entries(root: Path, base: Path) -> list[dict[str, str]]:
    if not root.exists():
        return []

    entries: list[dict[str, str]] = []
    for path in sorted(root.rglob("*.md")):
        meta = read_frontmatter(path)
        if not has_required_text(meta, "name", "description"):
            continue
        if not workflow_tool_references_are_indexable(meta, base):
            continue
        entries.append(
            {
                "name": str(meta.get("name") or path.stem),
                "path": display_path(path, base),
                "description": str(meta.get("description") or ""),
            }
        )
    return entries


def python_tool_index_entries(root: Path, base: Path) -> list[dict[str, object]]:
    if not root.exists():
        return []

    entries: list[dict[str, object]] = []
    for path in sorted(root.rglob("*.py")):
        if path.name.startswith("_"):
            continue
        meta = read_python_comment_metadata(path)
        if not python_tool_is_indexable(path):
            continue
        entry: dict[str, object] = {
            "name": str(meta.get("name") or path.stem),
            "path": display_path(path, base),
            "description": str(meta.get("description") or ""),
        }
        inputs = meta.get("inputs")
        if isinstance(inputs, list) and inputs:
            entry["inputs"] = [str(input_name) for input_name in inputs]
        entries.append(entry)
    return entries


def find_site(sites_dir: Path, host: str) -> tuple[Path, dict[str, object]] | None:
    if not sites_dir.exists():
        return None

    for site_dir in sorted(path for path in sites_dir.iterdir() if path.is_dir()):
        site_meta = read_frontmatter(site_dir / "site.md")
        if host in site_hosts(site_dir, site_meta):
            return site_dir, site_meta
    return None


def main() -> int:
    args = parse_args()
    url = args.url
    if not url:
        url, error = current_browser_url()
        if error:
            return output({"status": "error", "message": error}, exit_code=1)

    assert url is not None
    host = host_from_url(url)
    sites_dir = args.sites_dir
    base = display_base_for_sites_dir(sites_dir)
    site_match = find_site(sites_dir, host)

    if not site_match:
        return output({"status": "none", "url": url, "host": host})

    site_dir, site_meta = site_match
    site_md = site_dir / "site.md"
    data: dict[str, object] = {
        "status": "found",
        "url": url,
        "host": host,
        "site": {
            "name": str(site_meta.get("name") or site_dir.name),
            "path": display_path(site_md, base),
            "description": str(site_meta.get("description") or ""),
        },
        "tools": python_tool_index_entries(site_dir / "tools", base),
        "workflows": markdown_index_entries(site_dir / "workflows", base),
    }
    return output(data)


if __name__ == "__main__":
    raise SystemExit(main())
