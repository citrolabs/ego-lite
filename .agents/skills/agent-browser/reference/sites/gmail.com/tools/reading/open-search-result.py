#!/usr/bin/env python3
# ---
# name: open-search-result
# description: Open the Nth visible Gmail search result or message row.
# inputs:
#   - index
# ---

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _common import completed_error, completed_output, finish, run_agent_browser  # noqa: E402


ROW_REF_RE = re.compile(r'^\s*-\s+row\b.*\[ref=(e\d+)\].*clickable')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Open a Gmail result row.")
    parser.add_argument("--index", type=int, default=1, help="1-based result index.")
    return parser.parse_args()


def result_refs(snapshot: str) -> list[str]:
    refs: list[str] = []
    for line in snapshot.splitlines():
        match = ROW_REF_RE.search(line)
        if match:
            refs.append(match.group(1))
    return refs


def main() -> int:
    args = parse_args()
    if args.index < 1:
        return finish("error", "Index must be 1 or greater.", exit_code=2)

    snapshot_result = run_agent_browser("snapshot", "-i", "-s", 'div[role="main"]', "--max-output", "50000")
    if snapshot_result.returncode != 0:
        return finish("error", completed_error(snapshot_result), exit_code=1)

    refs = result_refs(snapshot_result.stdout)
    if len(refs) < args.index:
        return finish("none", "No visible search results found.", data={"count": len(refs)})

    click_result = run_agent_browser("click", f"@{refs[args.index - 1]}")
    if click_result.returncode != 0:
        return finish("error", completed_error(click_result), exit_code=1)

    run_agent_browser("wait", "1000")
    title_result = run_agent_browser("get", "title")
    url_result = run_agent_browser("get", "url")
    data = {"index": args.index}
    if title_result.returncode == 0:
        data["title"] = completed_output(title_result)
    if url_result.returncode == 0:
        data["url"] = completed_output(url_result)

    return finish("ok", "Result opened.", data=data)


if __name__ == "__main__":
    raise SystemExit(main())
