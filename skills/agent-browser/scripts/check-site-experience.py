#!/usr/bin/env python3
"""Find saved Agent Browser experience for the current or target site."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _lib import (  # noqa: E402
    DANGEROUS_PATTERNS,
    display_path,
    has_required_text,
    is_under,
    output,
    read_frontmatter,
    read_python_comment_metadata,
)

SKILL_ROOT = SCRIPT_DIR.parent
DEFAULT_SITES_DIR = SKILL_ROOT / "reference" / "sites"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Return a YAML index of saved site experience for Agent Browser."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--site", help="Site folder name (e.g. example.com). Skips URL resolution.")
    group.add_argument("--url", help="Target URL. Defaults to `agent-browser get url`.")
    parser.add_argument(
        "--sites-dir",
        type=Path,
        default=DEFAULT_SITES_DIR,
        help="Directory containing site experience folders.",
    )
    return parser.parse_args()


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


def display_base_for_sites_dir(sites_dir: Path) -> Path:
    resolved = sites_dir.resolve()
    if resolved.name == "sites" and resolved.parent.name == "reference":
        return resolved.parent.parent
    return resolved.parent


def site_hosts(site_dir: Path, site_meta: dict[str, object]) -> set[str]:
    hosts = {site_dir.name.lower()}
    frontmatter_hosts = site_meta.get("hosts", [])
    if isinstance(frontmatter_hosts, list):
        hosts.update(str(host).lower() for host in frontmatter_hosts)
    return hosts


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
    url: str | None = None

    if args.site:
        host = args.site.lower()
    elif args.url:
        url = args.url
        host = host_from_url(url)
    else:
        url, error = current_browser_url()
        if error:
            return output({"status": "error", "message": error}, exit_code=1)
        host = host_from_url(url)  # type: ignore[arg-type]

    sites_dir = args.sites_dir
    base = display_base_for_sites_dir(sites_dir)
    site_match = find_site(sites_dir, host)

    if not site_match:
        result: dict[str, object] = {"status": "none"}
        if url is not None:
            result["url"] = url
        result["host"] = host
        return output(result)

    site_dir, site_meta = site_match
    site_md = site_dir / "site.md"
    data: dict[str, object] = {"status": "found"}
    if url is not None:
        data["url"] = url
    data["host"] = host
    data["site"] = {
        "name": str(site_meta.get("name") or site_dir.name),
        "path": display_path(site_md, base),
        "description": str(site_meta.get("description") or ""),
    }
    data["tools"] = python_tool_index_entries(site_dir / "tools", base)
    data["workflows"] = markdown_index_entries(site_dir / "workflows", base)
    return output(data)


if __name__ == "__main__":
    raise SystemExit(main())
