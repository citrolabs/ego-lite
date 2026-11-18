const USER_AGENT =
  "ego-browser-wikipedia-plugin/1.0 (https://github.com/citrolabs/ego-plugins)";

export function normalizeLang(lang, context) {
  const value = String(lang || "en").toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]+)*$/.test(value)) {
    context.fail(
      "INVALID_ARGS",
      `${JSON.stringify(lang)} is not a Wikipedia language code`,
    );
  }
  return value;
}

/** Article URL for a title, e.g. ("en", "Ada Lovelace"). */
export function articleUrl(lang, title) {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}

/**
 * GET JSON from a Wikipedia API. Node's fetch is tried first because it is
 * not subject to the current page's CSP; when Node has no network route (for
 * example a browser-only proxy) the request is retried from the Page.
 */
export async function getJson(url, context) {
  let nodeError;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return { status: 404, body: null };
    if (response.status === 429)
      context.fail("RATE_LIMITED", "Wikipedia returned HTTP 429");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { status: response.status, body: await response.json() };
  } catch (error) {
    if (error?.code && error.name === "PluginError") throw error;
    nodeError = error;
  }
  const corsUrl = new URL(url);
  if (corsUrl.pathname.endsWith("/api.php"))
    corsUrl.searchParams.set("origin", "*");
  const response = await context.page
    .fetch(corsUrl.href, {
      timeout: 15_000,
      headers: { accept: "application/json" },
    })
    .catch((error) => {
      throw new Error(
        `Wikipedia request failed from Node (${nodeError?.message}) and from the page (${error.message})`,
      );
    });
  if (response.status === 404) return { status: 404, body: null };
  if (response.status === 429)
    context.fail("RATE_LIMITED", "Wikipedia returned HTTP 429");
  if (!response.ok)
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return { status: response.status, body: JSON.parse(response.body || "null") };
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
