import { articleUrl, getJson, normalizeLang, stripHtml } from "./lib.mjs";

/** Full-text search over one Wikipedia language edition. */
export default async function search(args, context) {
  const lang = normalizeLang(args.lang, context);
  const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  url.search = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: args.query,
    srlimit: String(args.limit),
    srprop: "snippet|wordcount|timestamp",
    format: "json",
    formatversion: "2",
  }).toString();
  const { body } = await getJson(url.href, context);
  if (!body?.query?.search) {
    context.fail(
      "SITE_CHANGED",
      "the search API returned no query.search list",
    );
  }
  return {
    query: args.query,
    lang,
    total: body.query.searchinfo?.totalhits ?? null,
    results: body.query.search.map((item) => ({
      title: item.title,
      url: articleUrl(lang, item.title),
      snippet: stripHtml(item.snippet),
      wordCount: item.wordcount ?? null,
      updatedAt: item.timestamp ?? null,
    })),
  };
}
