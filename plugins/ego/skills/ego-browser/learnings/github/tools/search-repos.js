function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function searchRepos(ctx, args = {}) {
  const query = args.query || "";
  const maxResults = boundedInteger(args.maxResults, 25, 100);
  if (!query) throw new Error("search query is required");

  await ctx.openOrReuseTab(`https://github.com/search?q=${encodeURIComponent(query)}&type=repositories&s=stars&o=desc`, {
    wait: true,
  });
  await ctx.waitForLoad();

  const repos = await ctx.js(String.raw`(() => {
    const repos = [...document.querySelectorAll('[data-hydro-click*="repo"]')]
    return repos.slice(0, ${maxResults}).map(el => {
      const name = el.querySelector('h2 a')?.innerText?.trim() || ''
      const link = el.querySelector('h2 a')?.getAttribute('href') || ''
      const parts = link.split('/')
      const owner = parts[1] || ''
      const stars = el.querySelector('a[href*="stargazers"]')?.innerText?.replace(/\s/g, '') || ''
      return { name: parts[2] || name, owner, stars, link }
    }).filter(r => r.name)
  })()`);

  return repos;
}
