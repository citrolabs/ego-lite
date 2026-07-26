# GitHub Overview

## Stable URL patterns

- Repository search: `https://github.com/search?q=<query>&type=repositories`
- Repository home: `https://github.com/<owner>/<repo>`
- Trending: `https://github.com/trending/<language>?since=daily|weekly|monthly` (language segment optional)
- Issues / PRs: prefer URL query filters over UI clicks, e.g. `/issues?q=is%3Aissue+is%3Aopen+label%3Abug`
- Raw file content: `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>`

## Repository page (server-rendered)

- Star count: `#repo-stars-counter-star` — the `title` attribute holds the exact count (`"4,126"`); the visible text is abbreviated (`"4.1k"`)
- Fork count: `#repo-network-counter` — same `title` attribute pattern
- Description: `meta[property="og:description"]` is the most stable source; the About sidebar paragraph has no stable class
- README: `article.markdown-body` — fully server-rendered, safe to read text from

## Repository search (client-rendered React)

- Results container: `[data-testid="results-list"]`
- Result title link: `.search-title a` — href is `/owner/repo`
- Result description: the `span.search-match` outside `.search-title` (the one inside `.search-title` is the repo name)
- Most other class names are hashed CSS modules (`Repositories-module__resultRow__...`) — never rely on them; stick to `data-testid`, `search-title`, and `search-match`
- Wait for `[data-testid="results-list"]` before extracting; the list hydrates after document load

## Trending page (server-rendered)

- Repo rows: `article.Box-row`
- Repo link: `h2 a` — href is `/owner/repo`
- Description: the `p` element inside the row
- Language: `span[itemprop="programmingLanguage"]`
- Stars: text of `a[href$="/stargazers"]`

## Issues and PR lists

- The issue/PR list UI is React-rendered with hashed class names — avoid scraping it
- Encode filters in the URL `q` parameter instead (`is:issue`, `is:open`, `label:...`, `author:...`)

## Login

- Search, repository pages, and trending all work logged out
- Writing actions (star, follow, comment, PR review) require the user's login session; hand off to the user if GitHub shows a login or 2FA prompt
