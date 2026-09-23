/**
 * Turn a fetched HTML document into the fields a PageSnapshot stores.
 * Parsing happens once per page; every rule then reads the snapshot, so adding a
 * rule costs no extra parsing.
 */
import * as cheerio from "cheerio";
import { sha256 } from "./crypto.js";
import { absoluteUrl, isProbablyAsset, normalizeUrl, registrableHost } from "./url.js";

export type ExtractedLink = {
  /** Normalised: the key pages are compared and counted by. */
  url: string;
  /** Absolute and as written (fragment removed): what the crawler requests. */
  href: string;
  internal: boolean;
  nofollow: boolean;
  anchor: string;
};

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
  /** h1–h6 in document order (first 80), for topic and outline comparisons. */
  headings: Array<{ level: number; text: string }>;
  /** Parsed JSON-LD blocks (at most 20, 64 KB together), for schema conflict checks. */
  jsonLd: unknown[];
  /** Content images with an absolute src (first 100); alt null = attribute missing. */
  images: Array<{ src: string; alt: string | null }>;
};

const MAX_HEADINGS = 80;
const MAX_JSONLD_BLOCKS = 20;
const MAX_JSONLD_BYTES = 64 * 1024;
const MAX_IMAGES = 100;

/** domhandler's AnyNode, reached through cheerio so it needs no dependency of its own. */
type AnyNode = Exclude<Parameters<typeof cheerio.load>[0], string | Buffer | unknown[]>;

/** Visible-text hash: ignores markup churn so duplicate detection is about content. */
function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[\u200c\u200f\u200e]/g, "")
    .trim()
    .toLowerCase();
}

/** Whitespace inside a title or heading is layout, not content, and must not count toward length. */
function collapse(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Text nodes joined with spaces. cheerio's .text() concatenates adjacent nodes,
 * so minified `<li>one</li><li>two</li>` would read as the single word "onetwo".
 */
function visibleText(nodes: AnyNode[]): string {
  const parts: string[] = [];
  const walk = (list: AnyNode[]) => {
    for (const node of list) {
      if (node.type === "text") parts.push(node.data);
      else if ("children" in node) walk(node.children as AnyNode[]);
    }
  };
  walk(nodes);
  return parts.join(" ");
}

/** JSON-LD @type values, including nodes inside @graph containers. */
function jsonLdTypes(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) jsonLdTypes(v, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as { "@type"?: unknown; "@graph"?: unknown };
  const type = node["@type"];
  if (typeof type === "string") out.push(type);
  else if (Array.isArray(type)) out.push(...type.filter((t): t is string => typeof t === "string"));
  if (node["@graph"] !== undefined) jsonLdTypes(node["@graph"], out);
}

export function extract(html: string, pageUrl: string): Extracted {
  const $ = cheerio.load(html);

  const structuredDataTypes: string[] = [];
  const jsonLd: unknown[] = [];
  let jsonLdBytes = 0;
  $('script[type="application/ld+json" i]').each((_, el) => {
    const raw = $(el).text();
    try {
      const parsed: unknown = JSON.parse(raw);
      jsonLdTypes(parsed, structuredDataTypes);
      if (jsonLd.length < MAX_JSONLD_BLOCKS && jsonLdBytes + raw.length <= MAX_JSONLD_BYTES) {
        jsonLd.push(parsed);
        jsonLdBytes += raw.length;
      }
    } catch {
      /* malformed JSON-LD is reported by its own rule, not here */
    }
  });

  $("script, style, noscript, template, svg").remove();

  // Meta names are case-insensitive in HTML (`name="Description"` counts).
  const metaContent = (name: string): string[] =>
    $("meta[name]")
      .filter((_, el) => ($(el).attr("name") ?? "").trim().toLowerCase() === name)
      .map((_, el) => collapse($(el).attr("content")))
      .get()
      .filter(Boolean);
  const linkRel = (rel: string) =>
    $("link[rel][href]").filter((_, el) =>
      ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes(rel),
    );

  // Relative URLs resolve against <base href> when the page declares one.
  const baseHref = $("base[href]").first().attr("href");
  const docBase = (baseHref && absoluteUrl(baseHref.trim(), pageUrl)) || pageUrl;

  const title = collapse($("head > title").first().text()) || null;
  const metaDescription = metaContent("description")[0] ?? null;
  const canonicalRaw = linkRel("canonical").first().attr("href");
  const canonical = canonicalRaw ? normalizeUrl(canonicalRaw.trim(), docBase) : null;
  // Googlebot obeys both its own meta and the generic one, so both are directives here.
  const robotsDirectives = [...metaContent("robots"), ...metaContent("googlebot")];
  const robotsMeta = robotsDirectives.length ? robotsDirectives.join(", ") : null;
  const lang = ($("html").attr("lang") ?? "").trim() || null;

  const h1s: string[] = [];
  $("h1").each((_, el) => {
    const text = collapse($(el).text());
    if (text) h1s.push(text);
  });
  const headings: Array<{ level: number; text: string }> = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    if (headings.length >= MAX_HEADINGS) return;
    const text = collapse($(el).text()).slice(0, 200);
    if (text && "tagName" in el) headings.push({ level: Number(el.tagName.slice(1)), text });
  });

  const bodyText = normalizeText(visibleText($("body").get()));
  const wordCount = bodyText ? bodyText.split(" ").filter((w) => w.length > 1).length : 0;

  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  const imagesWithoutAlt: Array<{ src: string; context: string }> = [];
  const images: Array<{ src: string; alt: string | null }> = [];
  $("img").each((_, el) => {
    imagesTotal++;
    const $el = $(el);
    const alt = $el.attr("alt");
    const src = $el.attr("src") ?? $el.attr("data-src") ?? "";
    const absolute = src && !src.startsWith("data:") ? absoluteUrl(src.trim(), docBase) : null;
    if (absolute && images.length < MAX_IMAGES) images.push({ src: absolute, alt: alt === undefined ? null : collapse(alt) });
    // A decorative image opts out with alt="" — that is correct, not a defect.
    if (alt === undefined) {
      imagesMissingAlt++;
      if (imagesWithoutAlt.length < 50) {
        const context =
          collapse($el.closest("figure").find("figcaption").first().text()) ||
          $el.attr("title") ||
          collapse($el.parent().text()).slice(0, 80) ||
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
    const href = $el.attr("href")?.trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    const abs = absoluteUrl(href, docBase);
    const key = abs ? normalizeUrl(abs) : null;
    if (!abs || !key || isProbablyAsset(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({
      url: key,
      href: abs,
      internal: registrableHost(new URL(key).hostname) === host,
      nofollow: /\bnofollow\b/i.test($el.attr("rel") ?? ""),
      anchor: collapse($el.text()).slice(0, 120),
    });
  });

  const hreflang: Array<{ lang: string; href: string }> = [];
  $("link[rel][hreflang][href]").each((_, el) => {
    if (!($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")) return;
    const l = $(el).attr("hreflang");
    const href = absoluteUrl(($(el).attr("href") ?? "").trim(), docBase);
    if (l && href) hreflang.push({ lang: l, href });
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
    hasViewport: metaContent("viewport").length > 0,
    structuredDataTypes: [...new Set(structuredDataTypes)],
    headings,
    jsonLd,
    images,
  };
}

export type IndexabilityInput = {
  statusCode: number;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  allowedByRobotsTxt: boolean;
  canonical: string | null;
  normalizedUrl: string;
  /** False for a response whose Content-Type is not HTML (a PDF, an image). */
  isHtml?: boolean;
};

export type Indexability = { indexable: boolean; reason: string | null };

/** One place that decides whether a page can appear in an index, and why not. */
export function indexability(input: IndexabilityInput): Indexability {
  if (input.statusCode >= 400) return { indexable: false, reason: `http_${input.statusCode}` };
  if (input.statusCode >= 300) return { indexable: false, reason: "redirect" };
  // Not an HTML document, so none of the HTML rules or the page score apply to it.
  if (input.isHtml === false) return { indexable: false, reason: "non_html" };
  const directives = `${input.robotsMeta ?? ""},${input.xRobotsTag ?? ""}`.toLowerCase();
  if (/\bnoindex\b/.test(directives)) return { indexable: false, reason: "meta_noindex" };
  if (/\bnone\b/.test(directives)) return { indexable: false, reason: "meta_none" };
  if (!input.allowedByRobotsTxt) return { indexable: false, reason: "robots_txt_disallow" };
  if (input.canonical && input.canonical !== input.normalizedUrl) {
    return { indexable: false, reason: "canonicalised_elsewhere" };
  }
  return { indexable: true, reason: null };
}
