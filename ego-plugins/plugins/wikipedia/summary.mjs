import { getJson, normalizeLang } from "./lib.mjs";

/** The lead summary of an article from the Wikipedia REST API. */
export default async function summary(args, context) {
  const lang = normalizeLang(args.lang, context);
  const title = encodeURIComponent(args.title.trim().replace(/ /g, "_"));
  const { status, body } = await getJson(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}?redirect=true`,
    context,
  );
  if (status === 404 || !body) {
    context.fail(
      "NOT_FOUND",
      `${lang}.wikipedia.org has no article ${JSON.stringify(args.title)}`,
    );
  }
  if (typeof body.extract !== "string") {
    context.fail("SITE_CHANGED", "the summary API returned no extract");
  }
  return {
    title: body.title,
    lang,
    url: body.content_urls?.desktop?.page || null,
    description: body.description || null,
    extract: body.extract,
    type: body.type || null,
    thumbnail: body.thumbnail?.source || null,
    updatedAt: body.timestamp || null,
  };
}
