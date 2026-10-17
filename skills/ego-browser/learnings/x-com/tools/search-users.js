export async function searchUsers(ctx, args = {}) {
  const query = args.query || "";
  if (!query) throw new Error("search query is required");

  await ctx.openOrReuseTab(`https://x.com/search?f=user&q=${encodeURIComponent(query)}`, { wait: true });
  await ctx.waitForLoad();

  const users = await ctx.js(String.raw`(() => {
    const results = [...document.querySelectorAll('[data-testid="cellInnerDiv"]')]
    return results.map(el => ({
      name: el.querySelector('[data-testid="User-Name"] span')?.innerText?.trim() || '',
      handle: el.querySelector('[data-testid="User-Name"] a')?.innerText?.trim() || '',
      followers: el.querySelector('[data-testid="Follow"]')?.previousElementSibling?.innerText?.trim() || '',
    })).filter(u => u.name || u.handle)
  })()`);

  return users;
}
