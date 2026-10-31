# X (Twitter) Overview

## Page structure
- Main navigation: Left sidebar `[data-testid="AppTabBar"]`
- Timeline content: `[data-testid="primaryColumn"]`
- Tweet items: `[data-testid="tweet"]` — each contains text, author, timestamp
- Compose box: `[data-testid="twaCreateTweetText"]`

## Anti-click-wrap
- Tweet text is inside `[data-testid="tweetText"]`, click target is `[data-testid="tweet"]`
- Actions (reply/retweet/like) are inside `div[role="group"]` at the bottom of each tweet card

## Common selectors
- Tweet text: `[data-testid="tweetText"]`
- Author name: `[data-testid="User-Name"] span`
- Timestamp: `time` element with `datetime` attribute
- Search input: `[data-testid="SearchBox_Search_Input"]`
- Compose textarea: `[data-testid="twaCreateTweetTextarea"]`
