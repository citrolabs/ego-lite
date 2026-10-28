# Google Search Overview

## Page structure
- Search input: `textarea[name="q"]` or `input[name="q"]`
- Results container: `div#search`
- Individual result items: `div.g`
- Result title: `h3` inside `div.g`
- Result link: `a[href]` inside `div.g a`
- Result snippet: text content below the title

## Navigation
- Use `openOrReuseTab` with `https://www.google.com/search?q=...`
- Results load immediately, no infinite scroll on first page
- Pagination links at bottom: `a[href*="/search?q="]`

## Common selectors
- Query box: `textarea[name="q"]`
- Search button: `input[type="submit"]`
- Auto-complete dropdown: `div[role="listbox"]`
- Auto-complete items: `.ssb-a`
