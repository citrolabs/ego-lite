export function boundedInteger(value, fallback, max, min = 1) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

export function extractVisiblePosts(page, maxPosts = 100) {
  const limit = boundedInteger(maxPosts, 100, 500);
  return page
    .locator('[data-testid="tweet"]')
    .evaluateAll((articles, itemLimit) => {
      const absoluteUrl = (value) => {
        if (!value) return "";
        try {
          return new URL(value, location.origin).href;
        } catch {
          return "";
        }
      };
      return articles
        .slice(0, itemLimit)
        .map((el) => {
          const textEl = el.querySelector('[data-testid="tweetText"]');
          const userNameEl = el.querySelector('[data-testid="User-Name"]');
          const labels = [...(userNameEl?.querySelectorAll("span") || [])]
            .map((span) => span.innerText?.trim() || "")
            .filter(Boolean);
          const time = el.querySelector("time");
          const statusLink =
            time?.closest("a") ||
            [...el.querySelectorAll('a[href*="/status/"]')][0];
          const statusPath = statusLink?.getAttribute("href") || "";
          const statusMatch = statusPath.match(/\/([^/]+)\/status\/(\d+)/);
          const links = [...(textEl?.querySelectorAll("a") || [])]
            .map((link) => ({
              text: link.innerText?.trim() || "",
              url: absoluteUrl(link.getAttribute("href")),
            }))
            .filter((link) => link.url);
          return {
            id: statusMatch?.[2] || "",
            url: absoluteUrl(statusPath),
            text: textEl?.innerText?.trim() || "",
            author: labels.find((label) => !label.startsWith("@")) || "",
            handle:
              labels.find((label) => label.startsWith("@")) ||
              (statusMatch?.[1] ? `@${statusMatch[1]}` : ""),
            timestamp: time?.getAttribute("datetime") || "",
            links,
          };
        })
        .filter((post) => post.id || post.url || post.text || post.author);
    }, limit);
}

export function extractArticle(page, maxChars = 50000) {
  const limit = boundedInteger(maxChars, 50000, 200000, 1000);
  return page.evaluate((articleLimit) => {
    const bodyRoot = document.querySelector(
      '[data-testid="twitterArticleRichTextView"], [data-testid="longformRichText"], [data-testid="articleBody"]',
    );
    const readRoot = document.querySelector(
      '[data-testid="twitterArticleReadView"]',
    );
    const root = readRoot || bodyRoot;
    if (!root) return null;
    const title =
      (readRoot || document)
        .querySelector('[data-testid="twitterArticleTitle"], h1')
        ?.innerText?.trim() || "";
    const fullText = (bodyRoot || root).innerText?.trim() || "";
    const images = [...root.querySelectorAll("img")]
      .map((img) => ({
        src: img.currentSrc || img.src || "",
        alt: img.alt || "",
      }))
      .filter((image) => image.src)
      .slice(0, 20);
    return {
      title,
      body: fullText.slice(0, articleLimit),
      truncated: fullText.length > articleLimit,
      images,
    };
  }, limit);
}
