/**
 * Turn a fetched HTML document into the fields a PageSnapshot stores.
 * Parsing happens once per page; every rule then reads the snapshot, so adding a
 * rule costs no extra parsing.
 */
import * as cheerio from "cheerio";
import { sha256 } from "./crypto.js";
import { isProbablyAsset, normalizeUrl, registrableHost } from "./url.js";

export type ExtractedLink = { url: string; internal: boolean; nofollow: boolean; anchor: string };

export type Extracted = {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  h1s: string[];
  canonical: string | null;
  robotsMeta: string | null;
  lang: string | null;
  wordCount: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  imagesWithoutAlt: Array<{ src: string; context: string }>;
  links: ExtractedLink[];
  internalLinksOut: number;
  externalLinksOut: number;
  contentHash: string;
  textHash: string;
  hreflang: Array<{ lang: string; href: string }>;
  hasViewport: boolean;
  structuredDataTypes: string[];
};

/** Visible-text hash: ignores markup churn so duplicate detection is about content. */
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[‌‏‎]/g, "")
    .trim()
    .toLowerCase();
}

export function extract(html: string, pageUrl: string): Extracted {
  const $ = cheerio.load(html);

  $("script, style, noscript, template, svg").remove();

  const title = ($("head > title").first().text() || "").trim() || null;
  const metaDescription =
    ($('head meta[name="description"]').attr("content") ?? "").trim() || null;
  const canonicalRaw = $('head link[rel="canonical"]').attr("href");
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, pageUrl) : null;
  const robotsMeta = ($('head meta[name="robots"]').attr("content") ?? "").trim() || null;
  const lang = ($("html").attr("lang") ?? "").trim() || null;

  const h1s: string[] = [];
  $("h1").each((_, el) => {
    const text = $(el).text().trim();
    if (text) h1s.push(text);
  });

  const bodyText = normalizeText($("body").text());
  const wordCount = bodyText ? bodyText.split(" ").filter((w) => w.length > 1).length : 0;

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  const imagesWithoutAlt: Array<{ src: string; context: string }> = [];
  $("img").each((_, el) => {
    imagesTotal++;
    const $el = $(el);
    const alt = $el.attr("alt");
    const src = $el.attr("src") ?? $el.attr("data-src") ?? "";
    // A decorative image opts out with alt="" — that is correct, not a defect.
    if (alt === undefined) {
      imagesMissingAlt++;
      if (imagesWithoutAlt.length < 50) {
        const context =
          $el.closest("figure").find("figcaption").first().text().trim() ||
          $el.attr("title") ||
          $el.parent().text().trim().slice(0, 80) ||
          "";
        imagesWithoutAlt.push({ src, context });
      }
    }
  });

  const host = registrableHost(new URL(pageUrl).hostname);
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    const abs = normalizeUrl(href, pageUrl);
    if (!abs || isProbablyAsset(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    let internal = false;
    try {
      internal = registrableHost(new URL(abs).hostname) === host;
    } catch {
      return;
    }
    links.push({
      url: abs,
      internal,
      nofollow: /\bnofollow\b/i.test($el.attr("rel") ?? ""),
      anchor: $el.text().trim().slice(0, 120),
    });
  });

  const hreflang: Array<{ lang: string; href: string }> = [];
  $('head link[rel="alternate"][hreflang]').each((_, el) => {
    const l = $(el).attr("hreflang");
    const href = $(el).attr("href");
    if (l && href) hreflang.push({ lang: l, href });
  });

  const structuredDataTypes: string[] = [];
  cheerio
    .load(html)('script[type="application/ld+json"]')
    .each((_, el) => {
      try {
        const parsed = JSON.parse(cheerio.load(html)(el).text());
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of nodes) {
          const type = (node as { "@type"?: string | string[] })["@type"];
          if (typeof type === "string") structuredDataTypes.push(type);
          else if (Array.isArray(type)) structuredDataTypes.push(...type);
        }
      } catch {
        /* malformed JSON-LD is reported by its own rule, not here */
      }
    });

  return {
    title,
    titleLength: title ? [...title].length : 0,
    metaDescription,
    metaDescriptionLength: metaDescription ? [...metaDescription].length : 0,
    h1s,
    canonical,
    robotsMeta,
    lang,
    wordCount,
    imagesTotal,
    imagesMissingAlt,
    imagesWithoutAlt,
    links,
    internalLinksOut: links.filter((l) => l.internal).length,
    externalLinksOut: links.filter((l) => !l.internal).length,
    contentHash: sha256(html),
    textHash: sha256(bodyText),
    hreflang,
    hasViewport: cheerio.load(html)('head meta[name="viewport"]').length > 0,
    structuredDataTypes: [...new Set(structuredDataTypes)],
  };
}

export type IndexabilityInput = {
  statusCode: number;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  allowedByRobotsTxt: boolean;
  canonical: string | null;
  normalizedUrl: string;
};

export type Indexability = { indexable: boolean; reason: string | null };

/** One place that decides whether a page can appear in an index, and why not. */
export function indexability(input: IndexabilityInput): Indexability {
  if (input.statusCode >= 400) return { indexable: false, reason: `http_${input.statusCode}` };
  if (input.statusCode >= 300) return { indexable: false, reason: "redirect" };
  const directives = `${input.robotsMeta ?? ""},${input.xRobotsTag ?? ""}`.toLowerCase();
  if (/\bnoindex\b/.test(directives)) return { indexable: false, reason: "meta_noindex" };
  if (/\bnone\b/.test(directives)) return { indexable: false, reason: "meta_none" };
  if (!input.allowedByRobotsTxt) return { indexable: false, reason: "robots_txt_disallow" };
  if (input.canonical && input.canonical !== input.normalizedUrl) {
    return { indexable: false, reason: "canonicalised_elsewhere" };
  }
  return { indexable: true, reason: null };
}
