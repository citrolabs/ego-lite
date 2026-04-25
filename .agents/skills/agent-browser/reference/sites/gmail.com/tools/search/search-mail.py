#!/usr/bin/env python3
# ---
# name: search-mail
# description: Search Gmail messages by query.
# inputs:
#   - query
# ---

from __future__ import annotations

import argparse
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _common import completed_error, completed_output, finish, run_agent_browser, wait_for_url_contains  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search Gmail messages.")
    parser.add_argument("--query", help="Gmail search query, for example is:unread.")
    return parser.parse_args()


def try_fill_search(query: str):
    attempts = [
        ("find", "role", "textbox", "fill", query, "--name", "Search mail"),
        ("find", "role", "textbox", "fill", query, "--name", "搜索邮件"),
        ("find", "placeholder", "Search mail", "fill", query),
        ("find", "placeholder", "搜索邮件", "fill", query),
        ("fill", 'input[aria-label="Search mail"]', query),
        ("fill", 'input[aria-label="搜索邮件"]', query),
        ("fill", 'input[name="q"]', query),
    ]

    last_result = None
    for attempt in attempts:
        result = run_agent_browser(*attempt)
        if result.returncode == 0:
            return result
        last_result = result
    return last_result


def main() -> int:
    args = parse_args()
    if not args.query:
        return finish("error", "Missing required input: query.", exit_code=2)

    fill_result = try_fill_search(args.query)
    if fill_result is None or fill_result.returncode != 0:
        return finish("error", completed_error(fill_result) if fill_result else "Search box not found.", exit_code=1)

    press_result = run_agent_browser("press", "Enter")
    if press_result.returncode != 0:
        return finish("error", completed_error(press_result), exit_code=1)

    url_result = wait_for_url_contains("#search/")
    data = {"query": args.query}
    if url_result and url_result.returncode == 0:
        data["url"] = completed_output(url_result)

    return finish("ok", "Search completed.", data=data)


if __name__ == "__main__":
    raise SystemExit(main())
