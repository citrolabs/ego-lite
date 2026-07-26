const FEEDS = new Set(["news", "newest", "front", "ask", "show", "best"]);

function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function getPosts(ctx, args = {}) {
  const feed = FEEDS.has(args.feed) ? args.feed : "news";
  const page = boundedInteger(args.page, 1, 20);
  const maxResults = boundedInteger(args.maxResults, 30, 30);

  await ctx.browser.openOrReuseTab(
    `https://news.ycombinator.com/${feed}?p=${page}`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");

  const posts = await ctx.page
    .locator("tr.athing.submission")
    .evaluateAll((rows, limit) => {
      return rows
        .slice(0, limit)
        .map((row) => {
          const titleLink = row.querySelector("span.titleline > a");
          const subtext = row.nextElementSibling?.querySelector("td.subtext");
          const commentsLink = [
            ...(subtext?.querySelectorAll('a[href^="item?id="]') || []),
          ].pop();
          return {
            id: row.id || "",
            rank:
              row
                .querySelector("span.rank")
                ?.innerText?.replace(".", "")
                .trim() || "",
            title: titleLink?.innerText?.trim() || "",
            url: titleLink?.href || "",
            score: subtext?.querySelector("span.score")?.innerText?.trim() || "",
            author: subtext?.querySelector("a.hnuser")?.innerText?.trim() || "",
            age: subtext?.querySelector("span.age")?.getAttribute("title") || "",
            comments: commentsLink?.innerText?.trim() || "",
          };
        })
        .filter((p) => p.title);
    }, maxResults);

  return posts;
}
