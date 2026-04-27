#!/usr/bin/env python3
"""Shared utilities for Agent Browser site experience scripts."""

from __future__ import annotations

import sys
from pathlib import Path


DANGEROUS_PATTERNS = [
    "rm -rf",
    "git reset --hard",
    "os.remove",
    "shutil.rmtree",
    ".unlink(",
]


def yaml_scalar(value: object) -> str:
    text = "" if value is None else str(value)
    if text == "":
        return '""'
    if text == "[]":
        return text
    needs_quotes = any(char in text for char in [": ", "#", "\n", '"', "[", "]", "{", "}"])
    if needs_quotes or text.strip() != text:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def emit_yaml(data: dict[str, object]) -> str:
    lines: list[str] = []

    def emit_value(key: str, value: object, indent: int) -> None:
        prefix = " " * indent
        if isinstance(value, dict):
            if not value:
                lines.append(f"{prefix}{key}: {{}}")
                return
            lines.append(f"{prefix}{key}:")
            for child_key, child_value in value.items():
                emit_value(child_key, child_value, indent + 2)
            return
        if isinstance(value, list):
            if not value:
                lines.append(f"{prefix}{key}: []")
                return
            lines.append(f"{prefix}{key}:")
            for item in value:
                if isinstance(item, dict):
                    item_pairs = list(item.items())
                    first_key, first_value = item_pairs[0]
                    lines.append(f"{prefix}  - {first_key}: {yaml_scalar(first_value)}")
                    for child_key, child_value in item_pairs[1:]:
                        emit_value(child_key, child_value, indent + 4)
                else:
                    lines.append(f"{prefix}  - {yaml_scalar(item)}")
            return
        lines.append(f"{prefix}{key}: {yaml_scalar(value)}")

    for key, value in data.items():
        emit_value(key, value, 0)
    return "\n".join(lines) + "\n"


def output(data: dict[str, object], exit_code: int = 0) -> int:
    sys.stdout.write(emit_yaml(data))
    return exit_code


def strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


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
    return parse_metadata_lines(raw.splitlines())


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


def is_under(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def has_required_text(meta: dict[str, object], *keys: str) -> bool:
    for key in keys:
        value = meta.get(key)
        if not isinstance(value, str) or not value.strip():
            return False
    return True


def display_path(path: Path, base: Path) -> str:
    try:
        return path.resolve().relative_to(base.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()
