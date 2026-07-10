import { boundedInteger, extractVisiblePosts } from "./post-data.js";

const BOOKMARKS_URL = "https://x.com/i/bookmarks";

export async function getBookmarks(ctx, args = {}) {
  const maxPosts = boundedInteger(args.maxPosts, 100, 500);
  const maxScrolls = boundedInteger(args.maxScrolls, 30, 200);
  const idleScrolls = boundedInteger(args.idleScrolls, 3, 10);
  const waitMs = boundedInteger(args.waitMs, 800, 5000, 100);
  const fromTop = args.fromTop !== false;

  await ctx.browser.openOrReuseTab(BOOKMARKS_URL, {
    match: "origin+path",
    wait: true,
    timeout: 20000,
  });
  const currentUrl = await ctx.page.url();
  if (!isBookmarksPage(currentUrl)) {
    throw new Error(
      `X bookmarks requires a signed-in session; current page is ${JSON.stringify(currentUrl || "unknown")}`,
    );
  }

  if (fromTop) {
    await ctx.page.evaluate(() =>
      window.scrollTo({ top: 0, behavior: "auto" }),
    );
    await ctx.page.waitForTimeout(waitMs);
  }

  const posts = new Map();
  let scrolls = 0;
  let idleRounds = 0;
  let reason = "scroll-limit";

  for (let round = 0; round <= maxScrolls; round += 1) {
    const batch = await extractVisiblePosts(ctx.page, maxPosts);
    const sizeBefore = posts.size;
    for (const post of batch || []) {
      const key = postKey(post);
      if (key && !posts.has(key)) posts.set(key, post);
      if (posts.size >= maxPosts) break;
    }

    if (posts.size >= maxPosts) {
      reason = "limit";
      break;
    }
    if (round === maxScrolls) break;

    idleRounds = posts.size === sizeBefore ? idleRounds + 1 : 0;
    if (idleRounds >= idleScrolls) {
      reason = "idle";
      break;
    }

    await ctx.page.mouse.wheel(0, 1200);
    scrolls += 1;
    await ctx.page.waitForTimeout(waitMs);
  }

  const items = [...posts.values()].slice(0, maxPosts);
  return { items, count: items.length, scrolls, reason };
}

function isBookmarksPage(value) {
  try {
    const url = new URL(value);
    return isXHostname(url.hostname) && url.pathname.startsWith("/i/bookmarks");
  } catch {
    return false;
  }
}

function isXHostname(hostname) {
  return (
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com")
  );
}

function postKey(post) {
  if (!post || typeof post !== "object") return "";
  return (
    post.id ||
    post.url ||
    [post.handle, post.timestamp, post.text].filter(Boolean).join("\u0000")
  );
}
