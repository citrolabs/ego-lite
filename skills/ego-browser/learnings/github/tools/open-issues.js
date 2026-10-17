const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

export async function getOpenIssues(ctx, args = {}) {
  const owner = args.owner || "";
  const repo = args.repo || "";
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
    throw new Error("valid GitHub owner and repo are required");
  }

  await ctx.openOrReuseTab(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, { wait: true });
  await ctx.waitForLoad();

  const issues = await ctx.js(String.raw`(() => {
    const rows = [...document.querySelectorAll('[data-test-id="issue-list-item"]')]
    return rows.map(el => {
      const title = el.querySelector('a[aria-label*="issue"]')?.innerText?.trim() || el.querySelector('h2 a')?.innerText?.trim() || ''
      const number = el.querySelector('[itemprop="discussionUrl"]')?.innerText?.trim() || ''
      return { title, number }
    }).filter(i => i.title)
  })()`);

  return issues;
}
