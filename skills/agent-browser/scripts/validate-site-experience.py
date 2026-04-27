#!/usr/bin/env python3
"""Statically validate Agent Browser site experience files.

The validator is intentionally static: it checks metadata, references, counts,
and Python syntax without opening browsers or touching real websites.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _lib import (  # noqa: E402
    DANGEROUS_PATTERNS,
    display_path,
    is_under,
    output,
    read_frontmatter,
    read_python_comment_metadata,
)

SCRIPT_SKILL_ROOT = SCRIPT_DIR.parent
MAX_CATEGORY_FILES = 20
MAX_SITE_BODY_CHARS = 2000


def default_skill_root() -> Path:
    """Prefer the installed project skill when the source script is executed."""
    if SCRIPT_SKILL_ROOT.parent.name == "skills":
        repo_root = SCRIPT_SKILL_ROOT.parent.parent
        installed_root = repo_root / ".agents" / "skills" / SCRIPT_SKILL_ROOT.name
        if installed_root.exists():
            return installed_root
    return SCRIPT_SKILL_ROOT


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Return YAML validation results for one site experience folder."
    )
    parser.add_argument("--site", required=True, help="Site folder name, for example gmail.com.")
    parser.add_argument(
        "--skill-root",
        type=Path,
        default=default_skill_root(),
        help="Agent Browser skill root. Defaults to the current installed skill root.",
    )
    return parser.parse_args()


def read_markdown_body(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if text.startswith("---\n"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            return parts[2].strip("\n")
    return text.strip("\n")


def add_error(errors: list[dict[str, str]], message: str, path: Path | str | None = None) -> None:
    item = {"message": message}
    if path is not None:
        item["path"] = str(path)
    errors.append(item)


def validate_required_metadata(
    errors: list[dict[str, str]],
    meta: dict[str, object],
    required: list[str],
    label: str,
    path: Path,
    skill_root: Path,
) -> None:
    for key in required:
        value = meta.get(key)
        if not isinstance(value, str) or not value.strip():
            add_error(
                errors,
                f"Missing {label} metadata: {key}",
                display_path(path, skill_root),
            )


def validate_category_limits(site_dir: Path, skill_root: Path, errors: list[dict[str, str]]) -> None:
    for parent_name, pattern in [("tools", "*.py"), ("workflows", "*.md")]:
        parent = site_dir / parent_name
        if not parent.exists():
            continue
        for category_dir in sorted(path for path in parent.iterdir() if path.is_dir()):
            files = [path for path in category_dir.rglob(pattern) if path.is_file()]
            if len(files) > MAX_CATEGORY_FILES:
                add_error(
                    errors,
                    f"Category exceeds {MAX_CATEGORY_FILES} files: {display_path(category_dir, skill_root)}",
                    display_path(category_dir, skill_root),
                )


def validate_python_file(path: Path, skill_root: Path, errors: list[dict[str, str]]) -> None:
    relative = display_path(path, skill_root)
    source = path.read_text(encoding="utf-8")
    try:
        compile(source, str(path), "exec")
    except SyntaxError as exc:
        add_error(errors, f"Python compile failed: {exc.msg}", relative)

    for pattern in DANGEROUS_PATTERNS:
        if pattern in source:
            add_error(errors, f"Dangerous pattern found: {pattern}", relative)


def validate_tools(site_dir: Path, skill_root: Path, errors: list[dict[str, str]]) -> None:
    tools_dir = site_dir / "tools"
    if not tools_dir.exists():
        return

    for path in sorted(tools_dir.rglob("*.py")):
        validate_python_file(path, skill_root, errors)
        if path.name.startswith("_"):
            continue
        meta = read_python_comment_metadata(path)
        validate_required_metadata(errors, meta, ["name", "description"], "tool", path, skill_root)
        inputs = meta.get("inputs")
        if inputs is not None and not isinstance(inputs, list):
            add_error(errors, "Tool inputs metadata must be a list", display_path(path, skill_root))


def validate_workflow_tool_reference(
    tool_ref: object,
    workflow_path: Path,
    skill_root: Path,
    errors: list[dict[str, str]],
) -> None:
    relative_workflow = display_path(workflow_path, skill_root)
    if not isinstance(tool_ref, str) or not tool_ref.strip():
        add_error(errors, "Workflow tool reference must be a non-empty path", relative_workflow)
        return
    if tool_ref.startswith("/") or ".." in Path(tool_ref).parts:
        add_error(errors, f"Workflow tool reference must stay inside the skill root: {tool_ref}", relative_workflow)
        return

    target = (skill_root / tool_ref).resolve()
    if not is_under(target, skill_root):
        add_error(errors, f"Workflow tool reference must stay inside the skill root: {tool_ref}", relative_workflow)
        return
    if not target.exists():
        add_error(errors, f"Workflow references missing tool: {tool_ref}", relative_workflow)
        return
    if target.suffix != ".py" or "/tools/" not in target.as_posix():
        add_error(errors, f"Workflow reference is not a Python tool: {tool_ref}", relative_workflow)


def validate_workflows(site_dir: Path, skill_root: Path, errors: list[dict[str, str]]) -> None:
    workflows_dir = site_dir / "workflows"
    if not workflows_dir.exists():
        return

    for path in sorted(workflows_dir.rglob("*.md")):
        meta = read_frontmatter(path)
        validate_required_metadata(errors, meta, ["name", "description"], "workflow", path, skill_root)
        tools = meta.get("tools")
        if not isinstance(tools, list) or not tools:
            add_error(errors, "Missing workflow metadata: tools", display_path(path, skill_root))
            continue
        for tool_ref in tools:
            validate_workflow_tool_reference(tool_ref, path, skill_root, errors)


def validate_site(site: str, skill_root: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    site_dir = skill_root / "reference" / "sites" / site
    site_md = site_dir / "site.md"

    if not site_dir.exists():
        add_error(errors, "Site experience folder not found", display_path(site_dir, skill_root))
        return errors, warnings
    if not site_md.exists():
        add_error(errors, "Missing site.md", display_path(site_md, skill_root))
    else:
        site_meta = read_frontmatter(site_md)
        validate_required_metadata(errors, site_meta, ["name", "description"], "site", site_md, skill_root)
        site_body = read_markdown_body(site_md)
        if len(site_body) > MAX_SITE_BODY_CHARS:
            add_error(
                errors,
                f"site.md body exceeds {MAX_SITE_BODY_CHARS} characters: {len(site_body)}",
                display_path(site_md, skill_root),
            )
        hosts = site_meta.get("hosts")
        if hosts is not None and not isinstance(hosts, list):
            add_error(errors, "Site hosts metadata must be a list", display_path(site_md, skill_root))

    validate_category_limits(site_dir, skill_root, errors)
    validate_tools(site_dir, skill_root, errors)
    validate_workflows(site_dir, skill_root, errors)
    return errors, warnings


def main() -> int:
    args = parse_args()
    skill_root = args.skill_root.resolve()
    errors, warnings = validate_site(args.site, skill_root)
    status = "error" if errors else "ok"
    return output(
        {
            "status": status,
            "site": args.site,
            "errors": errors,
            "warnings": warnings,
        },
        exit_code=1 if errors else 0,
    )


if __name__ == "__main__":
    raise SystemExit(main())
