import { articleUrl, normalizeLang } from "./lib.mjs";

/**
 * The readable content of an article: lead, sections, infobox and
 * categories. Opens the article in the Page, so it also works for pages that
 * need the browser (for example a signed-in wiki session).
 */
export default async function article(args, context) {
  const { page } = context;
  let url;
  if (args.url) {
    url = args.url;
  } else if (args.title) {
    url = articleUrl(normalizeLang(args.lang, context), args.title);
  } else {
    url = await page.url();
    if (!/^https?:\/\/[^/]*wikipedia\.org\/wiki\//.test(url)) {
      context.fail(
        "INVALID_ARGS",
        "pass { title } or { url }, or call it on a Page that already shows a Wikipedia article",
      );
    }
  }
  if (!/^https?:\/\/[^/]*wikipedia\.org\//.test(url)) {
    context.fail("INVALID_ARGS", `${url} is not a wikipedia.org URL`);
  }
  if ((await page.url().catch(() => "")) !== url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  try {
    await page.waitForSelector("#mw-content-text", { timeout: 15_000 });
  } catch {
    context.fail("SITE_CHANGED", `no #mw-content-text on ${url}`);
  }
  const result = await page.evaluate(extractArticleInPage, {
    maxSections: args.maxSections,
  });
  if (result.missing) {
    context.fail("NOT_FOUND", `${url} has no article`);
  }
  return result;
}

function extractArticleInPage({ maxSections }) {
  const SKIP =
    "style, script, sup.reference, .mw-editsection, .reference, .noprint, .mw-empty-elt, .mw-cite-backlink, .navbox, .metadata, .sistersitebox, .shortdescription, .hatnote, .mw-ref, .reflist, .mbox-small";
  const clean = (element) => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll(SKIP).forEach((node) => node.remove());
    return copy.textContent
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };
  if (document.querySelector(".noarticletext, #noarticletext")) {
    return { missing: true };
  }
  const root = document.querySelector("#mw-content-text .mw-parser-output");
  const heading = (element) => {
    if (/^H[2-6]$/.test(element.tagName)) return element;
    if (element.classList.contains("mw-heading")) {
      return element.querySelector("h2, h3, h4, h5, h6");
    }
    return null;
  };
  const leadParts = [];
  const sections = [];
  let current = null;
  // Older skins put headings and paragraphs directly under .mw-parser-output;
  // newer ones wrap each section in <section>. Walk both in document order.
  const visit = (container) => {
    for (const element of container.children) {
      if (element.tagName === "SECTION") {
        visit(element);
        continue;
      }
      const h = heading(element);
      if (h) {
        current = {
          title: clean(h),
          level: Number(h.tagName.slice(1)),
          text: "",
        };
        sections.push(current);
        continue;
      }
      if (!element.matches("p, ul, ol, dl, blockquote, div.poem, pre"))
        continue;
      if (
        element.closest(
          ".infobox, .navbox, .reflist, .refbegin, .mw-references-wrap",
        )
      ) {
        continue;
      }
      const text = clean(element);
      if (!text) continue;
      if (current) current.text += (current.text ? "\n\n" : "") + text;
      else leadParts.push(text);
    }
  };
  if (root) visit(root);
  const infobox = [];
  for (const row of document.querySelectorAll("table.infobox tr")) {
    const label = row.querySelector("th");
    const value = row.querySelector("td");
    if (label && value) {
      const entry = { label: clean(label), value: clean(value) };
      if (entry.label && entry.value) infobox.push(entry);
    }
  }
  const kept = sections;
  return {
    title:
      document.querySelector("#firstHeading")?.textContent.trim() ||
      document.title,
    url: document.querySelector('link[rel="canonical"]')?.href || location.href,
    lang: document.documentElement.lang || null,
    lead: leadParts.join("\n\n"),
    sections: maxSections ? kept.slice(0, maxSections) : kept,
    infobox,
    categories: [...document.querySelectorAll("#mw-normal-catlinks li a")].map(
      (a) => a.textContent.trim(),
    ),
    lastModified:
      document.querySelector("#footer-info-lastmod")?.textContent.trim() ||
      null,
  };
}
