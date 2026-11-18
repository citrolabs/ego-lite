// Shared X (x.com) page logic. Functions passed to page.evaluate() run in the
// page and must stay self-contained: they cannot use anything from this file.

const ARTICLE = 'article[data-testid="tweet"]';

/** Read every post currently rendered in the page, in DOM order. */
export function extractPostsInPage() {
  const count = (element) => {
    const label = element?.getAttribute("aria-label") || "";
    const match = label.replace(/[,\s]/g, "").match(/\d+/);
    return match ? Number(match[0]) : 0;
  };
  const author = (container) => {
    const block = container?.querySelector('[data-testid="User-Name"]');
    if (!block) return { name: null, handle: null };
    const lines = block.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const handle = lines.find((line) => line.startsWith("@"));
    return {
      name: lines[0] && !lines[0].startsWith("@") ? lines[0] : null,
      handle: handle ? handle.slice(1) : null,
    };
  };
  const linksIn = (textElement) =>
    [...(textElement?.querySelectorAll("a[href]") || [])]
      .map((anchor) => {
        const href = anchor.getAttribute("href") || "";
        if (href.startsWith("/hashtag/") || /^\/[A-Za-z0-9_]+$/.test(href)) {
          return null;
        }
        return anchor.href;
      })
      .filter(Boolean);

  const posts = [];
  for (const article of document.querySelectorAll(
    'article[data-testid="tweet"]',
  )) {
    // A quoted post is rendered as a nested role=link block inside the article.
    const quoteBlock = [...article.querySelectorAll('div[role="link"]')].find(
      (block) => block.querySelector('[data-testid="User-Name"]'),
    );
    const outside = (element) => !quoteBlock || !quoteBlock.contains(element);
    const time = [...article.querySelectorAll("time")].find(outside);
    const statusLink = time?.closest('a[href*="/status/"]');
    const href = statusLink?.getAttribute("href") || "";
    const id = href.match(/\/status\/(\d+)/)?.[1];
    // Promoted posts have no timestamp link; they are not part of the feed.
    if (!id) continue;
    const textElement = [
      ...article.querySelectorAll('[data-testid="tweetText"]'),
    ].find(outside);
    const quoteText = quoteBlock?.querySelector('[data-testid="tweetText"]');
    const quoteTime = quoteBlock?.querySelector("time");
    const views = article.querySelector('a[href$="/analytics"]');
    posts.push({
      id,
      url: new URL(
        href.replace(/\/(analytics|photo\/\d+|video\/\d+)$/, ""),
        location.origin,
      ).href,
      author: author(article),
      text: textElement ? textElement.innerText : "",
      lang: textElement?.getAttribute("lang") || null,
      createdAt: time?.getAttribute("datetime") || null,
      context:
        article
          .querySelector('[data-testid="socialContext"]')
          ?.innerText.trim() || null,
      metrics: {
        replies: count(article.querySelector('[data-testid="reply"]')),
        reposts: count(
          article.querySelector(
            '[data-testid="retweet"], [data-testid="unretweet"]',
          ),
        ),
        likes: count(
          article.querySelector('[data-testid="like"], [data-testid="unlike"]'),
        ),
        views: views ? count(views) : null,
      },
      media: [
        ...[...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
          .filter(outside)
          .map((image) => ({ type: "photo", url: image.src })),
        ...([...article.querySelectorAll('[data-testid="videoPlayer"]')].some(
          outside,
        )
          ? [{ type: "video", url: null }]
          : []),
      ],
      links: linksIn(textElement),
      quote: quoteBlock
        ? {
            author: author(quoteBlock),
            text: quoteText ? quoteText.innerText : "",
            createdAt: quoteTime?.getAttribute("datetime") || null,
          }
        : null,
    });
  }
  return posts;
}

/** Classify a page that shows no posts. */
export function pageStateInPage() {
  const path = location.pathname;
  return {
    url: location.href,
    loginWall:
      path.startsWith("/i/flow/login") ||
      path === "/login" ||
      Boolean(document.querySelector('[data-testid="loginButton"]')) ||
      (Boolean(document.querySelector('a[href="/login"]')) &&
        !document.querySelector(
          '[data-testid="SideNav_AccountSwitcher_Button"]',
        )),
    emptyState: Boolean(document.querySelector('[data-testid="emptyState"]')),
    profileHeader: Boolean(document.querySelector('[data-testid="UserName"]')),
    errorText:
      document.querySelector('[data-testid="error-detail"]')?.innerText ||
      [...document.querySelectorAll('[role="button"]')]
        .find((button) => /retry|重试/i.test(button.innerText))
        ?.closest('[data-testid="primaryColumn"]')
        ?.innerText.slice(0, 200) ||
      null,
    articles: document.querySelectorAll('article[data-testid="tweet"]').length,
  };
}

/**
 * Wait for posts to render; translate the usual non-post pages into plugin
 * error codes. Returns false when the page is a legitimate empty list.
 */
export async function waitForPosts(page, context, { emptyIsOk = true } = {}) {
  try {
    await page.waitForSelector(ARTICLE, { timeout: 15_000 });
    return true;
  } catch {
    const state = await page.evaluate(pageStateInPage);
    if (state.articles > 0) return true;
    if (state.loginWall) {
      context.fail("NOT_LOGGED_IN", `x.com asks to sign in (${state.url})`);
    }
    if (state.emptyState && emptyIsOk) return false;
    if (state.emptyState) {
      context.fail("NOT_FOUND", `x.com shows no content at ${state.url}`);
    }
    if (
      state.errorText &&
      /rate|limit|too many|稍后|频繁/i.test(state.errorText)
    ) {
      context.fail("RATE_LIMITED", state.errorText.trim());
    }
    if (state.errorText) {
      context.fail(
        "RATE_LIMITED",
        `x.com showed an error: ${state.errorText.trim()}`,
      );
    }
    context.fail(
      "SITE_CHANGED",
      `no posts appeared at ${state.url} and the page matches no known state`,
    );
  }
}

/**
 * Scroll the feed and collect unique posts until `limit` posts are found, the
 * feed stops growing, or the time budget runs out. X virtualizes the list, so
 * posts are read after every scroll instead of once at the end.
 */
export async function collectPosts(
  page,
  { limit, budgetMs = 60_000, skip } = {},
) {
  const collected = new Map();
  const deadline = Date.now() + budgetMs;
  let idleRounds = 0;
  while (collected.size < limit && idleRounds < 4 && Date.now() < deadline) {
    const batch = await page.evaluate(extractPostsInPage);
    let added = 0;
    for (const post of batch) {
      if (collected.has(post.id) || (skip && skip(post))) continue;
      collected.set(post.id, post);
      added += 1;
      if (collected.size >= limit) break;
    }
    if (collected.size >= limit) break;
    idleRounds = added > 0 ? 0 : idleRounds + 1;
    await page.evaluate(() =>
      window.scrollBy(0, Math.round(window.innerHeight * 1.5)),
    );
    await page.waitForTimeout(700 + idleRounds * 500);
  }
  return [...collected.values()].slice(0, limit);
}

/** Accept "nasa", "@nasa" or a profile URL; return the bare handle. */
export function normalizeHandle(value, context) {
  const raw = String(value).trim();
  const fromUrl = raw.match(
    /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)/i,
  );
  const handle = (fromUrl ? fromUrl[1] : raw).replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    context.fail("INVALID_ARGS", `${JSON.stringify(value)} is not an X handle`);
  }
  return handle;
}
