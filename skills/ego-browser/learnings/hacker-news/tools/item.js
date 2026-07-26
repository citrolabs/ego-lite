function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function getItem(ctx, args = {}) {
  const id = String(args.id || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("a numeric item id is required");
  const maxComments = boundedInteger(args.maxComments, 30, 100);

  await ctx.browser.openOrReuseTab(
    `https://news.ycombinator.com/item?id=${id}`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");

  const story = await ctx.page.locator(".fatitem").evaluateAll((items) => {
    const el = items[0];
    if (!el) return {};
    const titleLink = el.querySelector("span.titleline > a");
    return {
      title: titleLink?.innerText?.trim() || "",
      url: titleLink?.href || "",
      author: el.querySelector("a.hnuser")?.innerText?.trim() || "",
      score: el.querySelector("span.score")?.innerText?.trim() || "",
      age: el.querySelector("span.age")?.getAttribute("title") || "",
      text: el.querySelector(".toptext")?.innerText?.trim() || "",
    };
  });

  const comments = await ctx.page
    .locator("tr.athing.comtr")
    .evaluateAll((rows, limit) => {
      return rows
        .slice(0, limit)
        .map((row) => ({
          id: row.id || "",
          author: row.querySelector("a.hnuser")?.innerText?.trim() || "",
          indent: Number(
            row.querySelector("td.ind")?.getAttribute("indent") || 0,
          ),
          age: row.querySelector("span.age")?.getAttribute("title") || "",
          text: row.querySelector(".commtext")?.innerText?.trim() || "",
        }))
        .filter((c) => c.text);
    }, maxComments);

  return { id, ...story, comments };
}
