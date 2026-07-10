import { boundedInteger, extractVisiblePosts } from "./post-data.js";

export async function getTimelinePosts(ctx, args = {}) {
  const maxPosts = boundedInteger(args.maxPosts, 50, 100);
  return extractVisiblePosts(ctx.page, maxPosts);
}
