import { collectPosts, normalizeHandle, waitForPosts } from "./lib/posts.mjs";

/** Recent posts from a profile, or from the signed-in home timeline. */
export default async function timeline(args, context) {
  const { page } = context;
  const handle = args.user ? normalizeHandle(args.user, context) : null;
  const url = handle ? `https://x.com/${handle}` : "https://x.com/home";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const hasPosts = await waitForPosts(page, context);
  if (!hasPosts) {
    const profileExists = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="UserName"]')),
    );
    if (handle && !profileExists) {
      context.fail("NOT_FOUND", `x.com has no account @${handle}`);
    }
    return { source: handle ? "profile" : "home", user: handle, posts: [] };
  }
  const posts = await collectPosts(page, {
    limit: args.limit,
    // Reposts appear in a profile feed under the original author; keep them
    // only when asked so "posts by @user" means what it says.
    skip:
      handle && !args.includeReposts
        ? (post) => post.author.handle?.toLowerCase() !== handle.toLowerCase()
        : undefined,
  });
  return { source: handle ? "profile" : "home", user: handle, posts };
}
