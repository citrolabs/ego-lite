# X Timeline Navigation

## Scrolling timeline
- Timeline is inside `[data-testid="primaryColumn"]`
- Posts load lazily as you scroll — use `scrollToBottomUntil` to load more
- Virtual list: DOM only renders visible articles + buffer

## Extracting posts
- Query `[data-testid="tweet"]` for post elements
- Each post has `[data-testid="tweetText"]` for content
- Author info at `[data-testid="User-Name"]`
- Always extract in one pass via browser-side closure

## Pinned post
- Pinned post is the first `[data-testid="tweet"]` in timeline
- To filter pinned post, skip the first element only when at top of timeline
