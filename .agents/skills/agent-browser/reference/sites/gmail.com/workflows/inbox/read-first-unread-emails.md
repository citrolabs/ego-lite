---
name: read-first-unread-emails
description: Read and summarize the first N unread Gmail messages.
tools:
  - reference/sites/gmail.com/tools/search/search-mail.py
  - reference/sites/gmail.com/tools/reading/open-search-result.py
  - reference/sites/gmail.com/tools/reading/read-current-email.py
  - reference/sites/gmail.com/tools/navigation/back-to-results.py
---

# Read first unread emails

Goal: read the first unread Gmail messages, defaulting to 5 messages.

Use these tools:

- `reference/sites/gmail.com/tools/search/search-mail.py`
- `reference/sites/gmail.com/tools/reading/open-search-result.py`
- `reference/sites/gmail.com/tools/reading/read-current-email.py`
- `reference/sites/gmail.com/tools/navigation/back-to-results.py`

Steps:

1. Run `search-mail.py --query "is:unread"`.
2. Repeat until the requested count is collected or no result is available:
   - Run `open-search-result.py --index 1`.
   - Run `read-current-email.py` and keep the YAML `data.text` as the source.
   - Run `back-to-results.py`.

Safety and side effects:

- Do not send mail, delete messages, archive messages, open attachments, or click external links.
- Opening unread messages may mark them as read.
- Tool scripts may use JavaScript through `agent-browser eval --stdin` for read-only diagnostics, but visible user actions should use Agent Browser UI commands.
- Do not save `@eN` refs as reusable experience.
