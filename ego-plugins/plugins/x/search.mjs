import { collectPosts, waitForPosts } from "./lib/posts.mjs";

/** Posts matching an X search query. */
export default async function search(args, context) {
  const { page } = context;
  const url = new URL("https://x.com/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("src", "typed_query");
  if (args.tab === "latest") url.searchParams.set("f", "live");
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const hasPosts = await waitForPosts(page, context);
  const posts = hasPosts ? await collectPosts(page, { limit: args.limit }) : [];
  return { query: args.query, tab: args.tab, posts };
}
