function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function searchAndExtract(ctx, args = {}) {
  const query = args.query || "";
  const maxResults = boundedInteger(args.maxResults, 10, 100);
  if (!query) throw new Error("search query is required");

  await ctx.browser.openOrReuseTab(
    `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");

  // Anchor on the result link, not on a container class. Google's container
  // classes rotate — div.g stopped matching anything — while an <a> wrapping an
  // <h3> inside #search has stayed the stable shape of an organic hit.
  const results = await ctx.page
    .locator("#search a:has(h3)")
    .evaluateAll((links, limit) => {
      return links
        .slice(0, limit)
        .map((a) => {
          const block = a.closest("div[data-hveid]") || a.parentElement;
          return {
            title: a.querySelector("h3")?.innerText?.trim() || "",
            url: a.getAttribute("href") || "",
            snippet:
              block?.querySelector("[data-sncf]")?.innerText?.trim() || "",
          };
        })
        .filter((r) => r.title && r.url);
    }, maxResults);

  return results;
}
