---
name: mail.google.com
description: Gmail web UI result-list mechanics for read-only mailbox analysis.
hosts:
  - mail.google.com
---

Gmail's desktop result list exposes message/thread rows as `tr[role="row"].zA`.
The sender cell is `.yW`; sender identity is available from nested `[email]`
elements via `name` and `email` attributes. The full displayed date is usually
on `td.xW span[title]`.

Search URLs can use the hash form `/#search/<encoded Gmail query>`. Date-bounded
queries such as `after:YYYY/M/D before:YYYY/M/D` are useful for small, verifiable
result windows. Verify that visible row dates match the requested window before
aggregating results.

Desktop Gmail pagination may update the URL/range label while leaving stale row
DOM visible in automation. For read-only counts across a large period, prefer
splitting into smaller date windows and validating row dates instead of trusting
the next-page button.
