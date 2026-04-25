---
name: X
description: X/Twitter web UI notes for reading timeline content.
hosts:
  - x.com
  - twitter.com
---

- Use `https://x.com/home` for the authenticated home timeline. If a logged-in
  session is not present, the site may show the public landing page; restart
  agent-browser with the user's normal Chrome profile, for example
  `--profile Default`, instead of using signup buttons.
- The home timeline has `For you` / `Following` tabs, localized in the page UI
  such as `为你推荐` / `正在关注`. Click the `Following` tab when the task asks
  about accounts the user follows.
- Timeline posts render as `article` elements. Read-only extraction can use
  `document.querySelectorAll('article')`, `innerText`, and the first non-photo,
  non-analytics anchor whose URL matches `/status/` as the post URL. De-duplicate
  by status URL while scrolling.
- A `View new posts` / `查看新帖子` control may appear after the timeline has
  been open for a while; clicking it refreshes the top of the current timeline.
