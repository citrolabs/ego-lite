# X Bookmarks and Articles

## Reading bookmarks

- X bookmarks live at `https://x.com/i/bookmarks` and require the active browser profile to be signed in.
- The page is a virtualized timeline: only the visible posts and a small buffer remain in the DOM.
- Use `runSiteTool("x-com", "get_bookmarks", { maxPosts: 100 })` to scroll, deduplicate by status id/URL, and stop after bounded idle rounds.
- Results include stable post ids and URLs so callers can persist a cursor and avoid reprocessing older bookmarks.

## Reading a post or long article

- Use `runSiteTool("x-com", "get_post", { url })` for a status or article page.
- The tool matches the main status id instead of assuming the first conversation card is the requested post.
- Expanded X Articles are returned under `article`; ordinary posts return `article: null`.
- Article bodies are bounded by `maxArticleChars` to prevent unexpectedly large model inputs.

## Safety and reliability

- These tools only read content available to the signed-in profile; they do not call private credentials or expose cookies.
- Login redirects are reported as errors instead of being mistaken for empty bookmark collections.
- Bookmark collection stops on an item limit, scroll limit, or repeated scrolls with no new ids.
