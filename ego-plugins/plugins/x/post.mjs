import {
  collectPosts,
  extractPostsInPage,
  waitForPosts,
} from "./lib/posts.mjs";

/** One post by URL or id, optionally with its first replies. */
export default async function post(args, context) {
  const { page } = context;
  const id = String(args.url ?? args.id ?? "").match(
    /(?:status\/)?(\d{5,25})(?:[/?#]|$)/,
  )?.[1];
  if (!id) {
    context.fail(
      "INVALID_ARGS",
      "pass { url } of an x.com post or its numeric { id }",
    );
  }
  await page.goto(`https://x.com/i/status/${id}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await waitForPosts(page, context, { emptyIsOk: false });
  // The focal post may render a moment after its parent posts.
  let focal;
  for (let attempt = 0; attempt < 10 && !focal; attempt += 1) {
    focal = (await page.evaluate(extractPostsInPage)).find(
      (item) => item.id === id,
    );
    if (!focal) await page.waitForTimeout(500);
  }
  if (!focal) {
    context.fail(
      "NOT_FOUND",
      `post ${id} did not render; it may be deleted or private`,
    );
  }
  if (args.replies === 0) return { post: focal, replies: [] };

  // Parent posts render above the focal post; replies render below it.
  const rendered = await page.evaluate(extractPostsInPage);
  const focalIndex = rendered.findIndex((item) => item.id === id);
  const above = new Set(
    rendered.slice(0, Math.max(focalIndex, 0)).map((item) => item.id),
  );
  const replies = await collectPosts(page, {
    limit: args.replies,
    skip: (item) => item.id === id || above.has(item.id),
  });
  return { post: focal, replies };
}
