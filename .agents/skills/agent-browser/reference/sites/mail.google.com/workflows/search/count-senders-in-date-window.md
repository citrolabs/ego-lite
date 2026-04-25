---
name: count-senders-in-date-window
description: Count Gmail result-list senders across a date window without opening messages.
tools:
  - reference/sites/mail.google.com/tools/search/read-visible-results.py
---

# Count Senders In A Date Window

Use desktop Gmail with `--auto-connect` so an existing authenticated session can
be reused. Navigate to hash-search URLs shaped like:

```text
https://mail.google.com/mail/u/0/#search/<url-encoded Gmail query>
```

For broad date ranges, avoid relying on the next-page button. Instead, split the
range into daily or otherwise small windows with Gmail search operators:

```text
is:unread after:YYYY/M/D before:YYYY/M/D
```

Read only list metadata. Extract visible rows from `tr[role="row"].zA`, sender
from `.yW [email]` (`name` and `email` attributes), date from
`td.xW span[title]`, and a stable thread key from `.bqe[data-thread-id]`.
Do not open messages or store subjects/snippets when only sender frequency is
needed.

After each search, poll until either no-result text appears or every visible row
has a parsed date matching the requested window. Track whether the next-page
button is enabled; if any small window still has pagination, report that the
count may be partial or split the window by another non-private dimension.

Deduplicate by thread key when the desired unit is Gmail result rows/threads.
If the desired unit is individual messages, note that Gmail conversation view can
collapse multiple messages into one visible row.
