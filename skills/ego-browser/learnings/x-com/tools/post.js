import {
  boundedInteger,
  extractArticle,
  extractVisiblePosts,
} from "./post-data.js";

export async function getPost(ctx, args = {}) {
  const requestedUrl = String(args.url || "").trim();
  if (requestedUrl) {
    assertXUrl(requestedUrl);
    await ctx.browser.openOrReuseTab(requestedUrl, {
      wait: true,
      timeout: 20000,
    });
  }

  const pageUrl = await ctx.page.url();
  assertXUrl(pageUrl || "");
  const currentId = statusId(pageUrl);
  const visiblePosts = await extractVisiblePosts(ctx.page, 50);
  const post =
    visiblePosts.find((item) => item.id && item.id === currentId) ||
    visiblePosts[0] ||
    null;
  const maxArticleChars = boundedInteger(
    args.maxArticleChars,
    50000,
    200000,
    1000,
  );
  const article = await extractArticle(ctx.page, maxArticleChars);

  if (!post && !article) {
    throw new Error("no X post or article content found on the current page");
  }
  return { ...(post || { url: pageUrl }), article };
}

function assertXUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`valid X URL required, got ${JSON.stringify(value)}`);
  }
  const hostname = url.hostname.toLowerCase();
  const isX =
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com");
  if (!isX || !["http:", "https:"].includes(url.protocol)) {
    throw new Error(`valid X URL required, got ${JSON.stringify(value)}`);
  }
}

function statusId(value) {
  try {
    return new URL(value).pathname.match(/\/status\/(\d+)/)?.[1] || "";
  } catch {
    return "";
  }
}
