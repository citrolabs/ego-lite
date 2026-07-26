function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function searchRepositories(ctx, args = {}) {
  const query = args.query || "";
  const maxResults = boundedInteger(args.maxResults, 10, 100);
  if (!query) throw new Error("search query is required");

  await ctx.browser.openOrReuseTab(
    `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");
  await ctx.page.waitForSelector('[data-testid="results-list"]');

  const results = await ctx.page
    .locator('[data-testid="results-list"] .search-title')
    .evaluateAll((titles, limit) => {
      return titles
        .slice(0, limit)
        .map((title) => {
          const link = title.querySelector("a");
          const descriptionEl = title
            .closest("h3")
            ?.nextElementSibling?.querySelector("span.search-match");
          return {
            name: link?.innerText?.trim() || "",
            url: link?.href || "",
            description: descriptionEl?.innerText?.trim() || "",
          };
        })
        .filter((r) => r.name);
    }, maxResults);

  return results;
}
