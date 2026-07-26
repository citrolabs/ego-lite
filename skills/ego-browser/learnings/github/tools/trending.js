const TRENDING_WINDOWS = new Set(["daily", "weekly", "monthly"]);

function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function getTrendingRepos(ctx, args = {}) {
  const language = String(args.language || "").trim().toLowerCase();
  const since = TRENDING_WINDOWS.has(args.since) ? args.since : "daily";
  const maxResults = boundedInteger(args.maxResults, 25, 25);

  const path = language
    ? `/trending/${encodeURIComponent(language)}`
    : "/trending";
  await ctx.browser.openOrReuseTab(
    `https://github.com${path}?since=${since}`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");

  const repos = await ctx.page
    .locator("article.Box-row")
    .evaluateAll((articles, limit) => {
      return articles
        .slice(0, limit)
        .map((el) => {
          const link = el.querySelector("h2 a");
          return {
            name: (link?.getAttribute("href") || "").replace(/^\//, ""),
            url: link?.href || "",
            description: el.querySelector("p")?.innerText?.trim() || "",
            language:
              el
                .querySelector('span[itemprop="programmingLanguage"]')
                ?.innerText?.trim() || "",
            stars:
              el.querySelector('a[href$="/stargazers"]')?.innerText?.trim() ||
              "",
          };
        })
        .filter((r) => r.name);
    }, maxResults);

  return repos;
}
