#!/usr/bin/env python3
# ---
# name: back-to-results
# description: Navigate back to the previous Gmail result list.
# inputs:
# ---

from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _common import completed_error, completed_output, finish, run_agent_browser, wait_for_url_contains  # noqa: E402


def main() -> int:
    back_result = run_agent_browser("back")
    if back_result.returncode != 0:
        return finish("error", completed_error(back_result), exit_code=1)

    url_result = wait_for_url_contains("#search/")
    title_result = run_agent_browser("get", "title")
    data: dict[str, str] = {}
    if url_result and url_result.returncode == 0:
        data["url"] = completed_output(url_result)
    if title_result.returncode == 0:
        data["title"] = completed_output(title_result)

    return finish("ok", "Returned to result list.", data=data)


if __name__ == "__main__":
    raise SystemExit(main())
