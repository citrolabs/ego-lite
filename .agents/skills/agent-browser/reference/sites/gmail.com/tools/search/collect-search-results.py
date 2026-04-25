#!/usr/bin/env python3
# ---
# name: collect-search-results
# description: Collect Gmail search result rows and sender summaries without opening messages.
# inputs:
#   - max-pages
#   - no-paginate
#   - include-examples
#   - include-rows
# ---

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _common import completed_error, finish, run_agent_browser, run_js  # noqa: E402


EXTRACT_RESULTS_JS = r"""
(() => {
  const clean = (value) => (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const rows = [...document.querySelectorAll('div[role="main"] tr[role="row"]')]
    .filter((row) => row.querySelector("[email]"));

  const resultRows = rows.map((row, index) => {
    const fromEl = row.querySelector(".zF[email], .yP[email], [email][name], [email]");
    const threadCountEl = row.querySelector(".bx0");
    const subjectEl = row.querySelector(".bog, .bqe");
    const dateEl = row.querySelector('td.xW span[title], td.xW span[aria-label], .bq3');
    const cells = [...row.querySelectorAll('[role="gridcell"]')].map((cell) => clean(cell.innerText));
    const threadCount = Number.parseInt(clean(threadCountEl?.textContent), 10) || 1;

    return {
      index,
      sender: clean(fromEl?.getAttribute("name") || fromEl?.textContent || cells[0] || ""),
      email: clean(fromEl?.getAttribute("email") || ""),
      subject: clean(subjectEl?.textContent || ""),
      visible_date: clean(dateEl?.textContent || cells[cells.length - 1] || ""),
      date_title: clean(dateEl?.getAttribute("title") || dateEl?.getAttribute("aria-label") || ""),
      thread_count: threadCount,
    };
  });

  const next = document.querySelector(
    '[aria-label="下一页结果"], [aria-label="Next page"], ' +
    '[data-tooltip="下一页结果"], [data-tooltip="Next page"]'
  );
  const bodyText = document.body.innerText || "";
  const chineseRange = bodyText.match(/第\s*\d+\s*-\s*\d+\s*行[^\n]*/);
  const englishRange = bodyText.match(/\d+\s*-\s*\d+\s+of\s+(?:many|\d+)/i);

  return JSON.stringify({
    range: clean(chineseRange?.[0] || englishRange?.[0] || ""),
    next_disabled: !next ||
      next.getAttribute("aria-disabled") === "true" ||
      next.hasAttribute("disabled") ||
      next.classList.contains("T-I-JE"),
    rows: resultRows,
  });
})()
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect Gmail search result rows and summarize senders without opening messages."
    )
    parser.add_argument("--max-pages", type=int, default=20, help="Maximum result pages to scan.")
    parser.add_argument("--no-paginate", action="store_true", help="Only collect the current visible result page.")
    parser.add_argument("--include-examples", action="store_true", help="Include up to three subjects per sender.")
    parser.add_argument("--include-rows", action="store_true", help="Include deduplicated raw rows in YAML output.")
    return parser.parse_args()


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").replace("\u00a0", " ").split())


def parse_eval_json(stdout: str) -> dict[str, Any]:
    """Parse agent-browser eval output, which may be raw JSON or a JSON-encoded string."""
    text = stdout.strip()
    parsed = json.loads(text)
    if isinstance(parsed, str):
        parsed = json.loads(parsed)
    if not isinstance(parsed, dict):
        raise ValueError("Expected a JSON object from Gmail result extraction.")
    return parsed


def collect_current_page() -> dict[str, Any]:
    result = run_js(EXTRACT_RESULTS_JS)
    if result.returncode != 0:
        raise RuntimeError(completed_error(result))
    return parse_eval_json(result.stdout)


def normalize_row(row: dict[str, Any], page: int, page_range: str) -> dict[str, Any]:
    thread_count = row.get("thread_count", 1)
    try:
        thread_count = max(1, int(thread_count))
    except (TypeError, ValueError):
        thread_count = 1

    return {
        "sender": clean_text(row.get("sender")),
        "email": clean_text(row.get("email")),
        "subject": clean_text(row.get("subject")),
        "visible_date": clean_text(row.get("visible_date")),
        "date_title": clean_text(row.get("date_title")),
        "thread_count": thread_count,
        "page": page,
        "page_range": clean_text(page_range),
    }


def row_identity(row: dict[str, Any]) -> tuple[str, str, str, str, str]:
    return (
        row["sender"],
        row["email"],
        row["subject"],
        row["visible_date"],
        row["date_title"],
    )


def click_next_page() -> None:
    attempts = [
        ('[aria-label="下一页结果"]',),
        ('[aria-label="Next page"]',),
        ('[data-tooltip="下一页结果"]',),
        ('[data-tooltip="Next page"]',),
    ]
    last_result = None
    for (selector,) in attempts:
        result = run_agent_browser("click", selector)
        if result.returncode == 0:
            run_agent_browser("wait", "1200")
            return
        last_result = result
    raise RuntimeError(completed_error(last_result) if last_result else "Next page button not found.")


def collect_pages(max_pages: int, paginate: bool) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
    rows: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    page_keys: set[tuple[tuple[str, str, str, str, str], ...]] = set()
    stopped_reason: str | None = None

    for page in range(1, max_pages + 1):
        payload = collect_current_page()
        page_range = clean_text(payload.get("range"))
        current_rows = [
            normalize_row(row, page, page_range)
            for row in payload.get("rows", [])
            if isinstance(row, dict)
        ]
        page_key = tuple(row_identity(row) for row in current_rows[:10])

        if page_key in page_keys:
            stopped_reason = "duplicate-page-detected"
            break
        page_keys.add(page_key)

        next_disabled = bool(payload.get("next_disabled"))
        pages.append(
            {
                "page": page,
                "range": page_range,
                "rows": len(current_rows),
                "next_disabled": next_disabled,
            }
        )
        rows.extend(current_rows)

        if not paginate:
            stopped_reason = "pagination-disabled"
            break
        if next_disabled:
            stopped_reason = "last-page"
            break
        if page == max_pages:
            stopped_reason = "max-pages-reached"
            break
        click_next_page()

    return deduplicate_rows(rows), pages, stopped_reason


def deduplicate_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique_rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for row in rows:
        identity = row_identity(row)
        if identity in seen:
            continue
        seen.add(identity)
        unique_rows.append(row)
    return unique_rows


def summarize_rows(rows: list[dict[str, Any]], include_examples: bool) -> dict[str, Any]:
    by_sender: Counter[str] = Counter()
    weighted_by_sender: Counter[str] = Counter()
    emails_by_sender: defaultdict[str, Counter[str]] = defaultdict(Counter)
    examples_by_sender: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in rows:
        sender = row["sender"] or "(unknown)"
        by_sender[sender] += 1
        weighted_by_sender[sender] += row["thread_count"]
        if row["email"]:
            emails_by_sender[sender][row["email"]] += 1
        if len(examples_by_sender[sender]) < 3:
            examples_by_sender[sender].append(
                {
                    "subject": row["subject"],
                    "visible_date": row["visible_date"],
                    "thread_count": row["thread_count"],
                }
            )

    top_senders: list[dict[str, Any]] = []
    for sender, count in by_sender.most_common(20):
        sender_data: dict[str, Any] = {
            "sender": sender,
            "count": count,
            "weighted_count": weighted_by_sender[sender],
            "emails": [
                {"email": email, "count": email_count}
                for email, email_count in emails_by_sender[sender].most_common(5)
            ],
        }
        if include_examples:
            sender_data["examples"] = examples_by_sender[sender]
        top_senders.append(sender_data)

    return {
        "total_conversation_rows": len(rows),
        "total_weighted_by_thread_count": sum(row["thread_count"] for row in rows),
        "top_senders": top_senders,
    }


def main() -> int:
    args = parse_args()
    if args.max_pages < 1:
        return finish("error", "max-pages must be 1 or greater.", exit_code=2)

    try:
        rows, pages, stopped_reason = collect_pages(args.max_pages, paginate=not args.no_paginate)
    except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
        return finish("error", str(exc), exit_code=1)

    data = {**summarize_rows(rows, args.include_examples), "pages": pages, "stopped_reason": stopped_reason or ""}
    if args.include_rows:
        data["rows"] = rows

    if not rows:
        return finish("none", "No Gmail search result rows found on the current search page.", data=data)
    return finish("ok", "Collected Gmail search result rows without opening messages.", data=data)


if __name__ == "__main__":
    raise SystemExit(main())
