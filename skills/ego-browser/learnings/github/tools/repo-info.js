function parseCounter(raw) {
  const number = Number(String(raw || "").replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

export async function getRepoInfo(ctx, args = {}) {
  const owner = String(args.owner || "").trim();
  const repo = String(args.repo || "").trim();
  if (!owner || !repo) throw new Error("owner and repo are required");

  const url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  await ctx.browser.openOrReuseTab(url, { wait: true });
  await ctx.page.waitForLoadState("load");

  // The title attribute holds the exact count; the visible text is abbreviated.
  const stars = await ctx.page
    .locator("#repo-stars-counter-star")
    .getAttribute("title");
  const forks = await ctx.page
    .locator("#repo-network-counter")
    .getAttribute("title");
  const description = await ctx.page
    .locator('meta[property="og:description"]')
    .getAttribute("content");

  return {
    name: `${owner}/${repo}`,
    url,
    description: (description || "").trim(),
    stars: parseCounter(stars),
    forks: parseCounter(forks),
  };
}
