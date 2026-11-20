# GitHub Overview

## Page structure
- Navigation: Header with logo, search, notifications
- Repository page: `[data-view-component]` wraps the repo body
- File tree: `#repo-files-toc` or `Box-row`
- Issues: `[data-test-id="issue-list-item"]` for issue rows

## Navigation patterns
- Repo URL: `https://github.com/{owner}/{repo}`
- Search URL: `https://github.com/search?q={query}&type=repositories`
- Issues URL: `https://github.com/{owner}/{repo}/issues`
- PR URL: `https://github.com/{owner}/{repo}/pulls`

## Common selectors
- Repo name: `[data-target="repo-banner.repoName"]`
- Stars button: `a.Link--muted[data-hydro-click*="stargazers"]`
- Forks button: `a.Link--muted[data-hydro-click*="forks"]`
- Language: `[itemprop="programmingLanguage"]`
- Description: About section content
- Search input: `input[data-testid="search-input"]` or `input.repository-search-bar-input`
