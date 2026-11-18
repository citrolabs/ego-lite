import { normalizeHandle } from "./lib/posts.mjs";

/** Public profile fields of an X account. */
export default async function profile(args, context) {
  const { page } = context;
  const handle = normalizeHandle(args.user, context);
  await page.goto(`https://x.com/${handle}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  try {
    await page.waitForSelector(
      '[data-testid="UserName"], [data-testid="emptyState"], [data-testid="loginButton"]',
      {
        timeout: 15_000,
      },
    );
  } catch {
    context.fail("SITE_CHANGED", "the profile header did not appear");
  }
  const result = await page.evaluate((expected) => {
    const parseCount = (text) => {
      if (!text) return null;
      const match = text.replace(/,/g, "").match(/([\d.]+)\s*([KMB万亿]?)/i);
      if (!match) return null;
      const scale =
        { K: 1e3, M: 1e6, B: 1e9, 万: 1e4, 亿: 1e8 }[match[2].toUpperCase()] ||
        1;
      return Math.round(Number(match[1]) * scale);
    };
    if (document.querySelector('[data-testid="loginButton"]'))
      return { state: "login" };
    const header = document.querySelector('[data-testid="UserName"]');
    if (!header) return { state: "missing" };
    const lines = header.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const followingLink = document.querySelector(`a[href$="/following" i]`);
    const followersLink =
      document.querySelector(`a[href$="/verified_followers" i]`) ||
      document.querySelector(`a[href$="/followers" i]`);
    return {
      state: "ok",
      profile: {
        handle: (
          lines.find((line) => line.startsWith("@")) || `@${expected}`
        ).slice(1),
        name: lines[0] || null,
        verified: Boolean(
          header.querySelector('[data-testid="icon-verified"]'),
        ),
        bio:
          document.querySelector('[data-testid="UserDescription"]')
            ?.innerText || "",
        location:
          document.querySelector('[data-testid="UserLocation"]')?.innerText ||
          null,
        website:
          document.querySelector('[data-testid="UserUrl"]')?.href || null,
        joined:
          document.querySelector('[data-testid="UserJoinDate"]')?.innerText ||
          null,
        following: parseCount(followingLink?.innerText),
        followers: parseCount(followersLink?.innerText),
        url: location.href,
      },
    };
  }, handle);
  if (result.state === "login")
    context.fail("NOT_LOGGED_IN", "x.com asks to sign in");
  if (result.state === "missing")
    context.fail("NOT_FOUND", `x.com has no account @${handle}`);
  return result.profile;
}
