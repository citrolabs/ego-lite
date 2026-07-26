function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function searchPosts(ctx, args = {}) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("search query is required");
  const maxResults = boundedInteger(args.maxResults, 10, 50);

  await ctx.browser.openOrReuseTab(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${maxResults}`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");

  const raw = await ctx.page
    .locator("body")
    .evaluateAll((bodies) => bodies[0]?.innerText || "");

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(
      "unexpected search response; hn.algolia.com may be unavailable",
    );
  }

  return (payload.hits || []).map((hit) => ({
    id: String(hit.objectID || ""),
    title: hit.title || "",
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author || "",
    points: hit.points ?? 0,
    numComments: hit.num_comments ?? 0,
    createdAt: hit.created_at || "",
  }));
}
