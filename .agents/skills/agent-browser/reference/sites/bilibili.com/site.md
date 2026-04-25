---
name: bilibili.com
description: Bilibili web mechanics for authenticated following-dynamic reading.
hosts:
  - bilibili.com
  - www.bilibili.com
  - t.bilibili.com
  - api.bilibili.com
---

Use `https://t.bilibili.com/` for the authenticated following dynamic feed.
If the page shows login prompts, restart agent-browser with the user's normal
Chrome profile, for example `--profile Default`, then reopen the dynamic page.

The web dynamic feed can be read with the same authenticated cookies through:
`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=all&timezone_offset=-480&page=1`.
Continue with the returned `data.offset` while `data.has_more` is true.

Each feed item stores author metadata under `modules.module_author` and content
under `modules.module_dynamic.major`. Common content shapes are `archive`
for videos, `draw` for image posts, `live_rcmd` for live cards, and `article`
for articles. `live_rcmd.content` may be a JSON string and should be parsed
before extracting title, link, watched count, or area.

