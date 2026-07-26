# Hacker News Overview

## Stable URL patterns

- Feeds: `https://news.ycombinator.com/<feed>?p=<page>` where feed is `news` (front page), `newest`, `front` (past days), `ask`, `show`, or `best`; pages are 1-based with 30 posts each
- Item (story + comments): `https://news.ycombinator.com/item?id=<id>`
- User profile: `https://news.ycombinator.com/user?id=<username>`
- Search API: `https://hn.algolia.com/api/v1/search?query=<q>&tags=story` — the on-site search UI at hn.algolia.com is client-rendered React, but this JSON API is public, documented, and stable

## Feed pages (server-rendered, identical markup across all feeds)

- Post row: `tr.athing.submission` — the `id` attribute is the item id
- Rank: `span.rank` (text like `1.`)
- Title and outbound link: `span.titleline > a` (first anchor)
- Metadata lives in the **next sibling row**, under `td.subtext`:
  - Score: `span.score` (text like `223 points`)
  - Author: `a.hnuser`
  - Age: `span.age` — the `title` attribute holds the exact ISO timestamp plus epoch seconds; the text is relative (`6 hours ago`)
  - Comment count: the last `a[href^="item?id="]` in the subtext (text like `128 comments`)

## Item pages

- Story header: `.fatitem` — contains the same `titleline` / `score` / `hnuser` / `age` markup as feeds
- Self-text (Ask HN etc.): `.toptext`
- Comment rows: `tr.athing.comtr` — `id` attribute is the comment id
- Comment text: `.commtext`; author: `a.hnuser`
- Thread depth: `td.ind` has an `indent` attribute (0 = top level)
- Long threads paginate with a "More" link at the bottom (`a.morelink`)

## Behavior and limits

- The whole site is server-rendered static HTML — no hydration to wait for; `load` state is enough
- HN rate-limits aggressive fetching ("we're not able to serve your requests this quickly") — navigate at a human pace and avoid tight page loops
- Reading is fully public; voting, commenting, and flagging require the user's login session — hand off to the user if a login form appears
