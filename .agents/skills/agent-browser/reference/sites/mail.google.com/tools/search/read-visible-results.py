#!/usr/bin/env python3
# ---
# name: read-visible-results
# description: Extract sender/date/thread metadata from visible Gmail search result rows.
# ---

"""Read metadata from the currently visible Gmail search result list."""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any


SCRAPE_JS = r"""
(() => {
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const text = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('tr[role="row"].zA')].filter(visible);
  const items = rows.map((row, idx) => {
    const senderBox = row.querySelector('.yW');
    const senderEls = senderBox ? [...senderBox.querySelectorAll('[email]')] : [];
    const primary = senderEls[0] || null;
    const displayed = text(senderBox).replace(/\s+\d+$/, '').trim();
    const name = (primary?.getAttribute('name') || primary?.textContent || displayed || '').trim();
    const email = (primary?.getAttribute('email') || '').trim();
    const dateNode = row.querySelector('td.xW span[title], td.xW [aria-label]');
    const dateTitle = dateNode?.getAttribute('title') || dateNode?.getAttribute('aria-label') || text(row.querySelector('td.xW'));
    const threadNode = row.querySelector('.bqe[data-thread-id], .bog .bqe');
    const threadId = threadNode?.getAttribute('data-thread-id') || row.getAttribute('id') || String(idx);
    return {sender: name, email, displayed, date: dateTitle, thread_id: threadId};
  });
  const body = document.body.innerText.replace(/\s+/g, ' ');
  const range = (body.match(/第\s*\d+\s*-\s*\d+\s*行，共有\s*(?:多|[\d,]+)行/) || [''])[0];
  const noResults = body.includes('找不到与您的搜索匹配的邮件') || body.includes('没有与搜索条件匹配');
  const next = document.querySelector('[aria-label="下一页结果"], [data-tooltip="下一页结果"]');
  const nextEnabled = !!next && next.getAttribute('aria-disabled') !== 'true' && !next.classList.contains('T-I-JE');
  return {url: location.href, range, no_results: noResults, next_enabled: nextEnabled, rows: items};
})()
"""


def yaml_scalar(value: Any) -> str:
    """Format a primitive value as a conservative YAML scalar."""
    if value is None:
        return '""'
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value)
    if text == "":
        return '""'
    needs_quotes = any(char in text for char in [": ", "#", "\n", '"', "[", "]", "{", "}"])
    if needs_quotes or text.strip() != text:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def emit_yaml(data: dict[str, Any]) -> str:
    """Emit simple dict/list data as YAML without requiring third-party packages."""
    lines: list[str] = []

    def emit_value(key: str, value: Any, indent: int) -> None:
        prefix = " " * indent
        if isinstance(value, dict):
            lines.append(f"{prefix}{key}:")
            for child_key, child_value in value.items():
                emit_value(child_key, child_value, indent + 2)
            return
        if isinstance(value, list):
            lines.append(f"{prefix}{key}:")
            for item in value:
                if isinstance(item, dict):
                    pairs = list(item.items())
                    if not pairs:
                        lines.append(f"{prefix}  - {{}}")
                        continue
                    first_key, first_value = pairs[0]
                    lines.append(f"{prefix}  - {first_key}: {yaml_scalar(first_value)}")
                    for child_key, child_value in pairs[1:]:
                        emit_value(child_key, child_value, indent + 4)
                else:
                    lines.append(f"{prefix}  - {yaml_scalar(item)}")
            return
        lines.append(f"{prefix}{key}: {yaml_scalar(value)}")

    for key, value in data.items():
        emit_value(key, value, 0)
    return "\n".join(lines) + "\n"


def run_eval() -> dict[str, Any]:
    """Run the read-only DOM extraction in the connected browser."""
    result = subprocess.run(
        ["agent-browser", "--auto-connect", "eval", SCRAPE_JS],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "agent-browser eval failed")
    return json.loads(result.stdout)


def main() -> int:
    try:
        data = run_eval()
    except Exception as exc:  # noqa: BLE001 - CLI tools should return structured failure.
        sys.stdout.write(emit_yaml({"status": "error", "message": str(exc)}))
        return 1

    row_count = len(data.get("rows") or [])
    sys.stdout.write(
        emit_yaml(
            {
                "status": "ok",
                "message": f"Read {row_count} visible Gmail result rows.",
                "data": data,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
