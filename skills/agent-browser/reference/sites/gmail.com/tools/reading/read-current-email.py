#!/usr/bin/env python3
# ---
# name: read-current-email
# description: Read the visible content of the currently opened Gmail message.
# inputs:
# ---

from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _common import completed_output, finish, run_agent_browser, run_js  # noqa: E402


def main_text() -> str:
    text_result = run_agent_browser("get", "text", 'div[role="main"]')
    if text_result.returncode == 0 and text_result.stdout.strip():
        return completed_output(text_result)

    # JS is used only as a read-side diagnostic fallback; it does not mutate Gmail.
    js_result = run_js('document.querySelector("div[role=main]")?.innerText || ""')
    if js_result.returncode == 0:
        return completed_output(js_result)
    return ""


def main() -> int:
    title_result = run_agent_browser("get", "title")
    url_result = run_agent_browser("get", "url")
    text = main_text()
    if not text:
        return finish("none", "No current email content found.")

    data = {"text": text}
    if title_result.returncode == 0:
        data = {"title": completed_output(title_result), **data}
    if url_result.returncode == 0:
        data["url"] = completed_output(url_result)

    return finish("ok", "Current email content read.", data=data)


if __name__ == "__main__":
    raise SystemExit(main())
