/**
 * Content HTML: an allowlist sanitiser, the structure the analyser reads, and
 * main-content extraction for importing a page.
 *
 * The sanitiser rebuilds the document from the parsed tree, emitting only
 * allowed elements and attributes with every text and attribute value
 * escaped — nothing from the input is copied through as markup, so there is no
 * parser-differential trick to smuggle a script past it. Links keep http(s),
 * mailto, tel, relative and fragment targets only; images keep http(s) and
 * relative sources.
 */
import * as cheerio from "cheerio";

type AnyNode = Exclude<Parameters<typeof cheerio.load>[0], string | Buffer | unknown[]>;

const ALLOWED: Record<string, readonly string[]> = {
  p: [], br: [], hr: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  strong: [], b: [], em: [], i: [], u: [], s: [], mark: [], small: [], sub: [], sup: [], code: [], pre: [], kbd: [],
  blockquote: ["cite"], q: ["cite"], ul: [], ol: ["start", "reversed"], li: [], dl: [], dt: [], dd: [],
  a: ["href", "title", "rel", "target"], img: ["src", "alt", "title", "width", "height", "loading"],
  figure: [], figcaption: [], table: [], thead: [], tbody: [], tfoot: [], tr: [], th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"], caption: [], span: [], div: [], section: [], article: [], abbr: ["title"], time: ["datetime"],
};
/** Dropped with everything inside them; other unknown elements are unwrapped (their text kept). */
const DROP = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "math", "form", "input", "button", "select", "textarea", "head", "title", "meta", "link", "nav", "footer", "aside"]);
const VOID = new Set(["br", "hr", "img"]);

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

function safeUrl(value: string, kind: "href" | "src"): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^(#|\/(?!\/)|\.\.?\/)/.test(v)) return v;
  if (kind === "href" && /^(mailto|tel):/i.test(v)) return v;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    // A bare relative path ("page.html") has no scheme to abuse.
    return /^[\w\-.~%]+(\/[\w\-.~%]*)*([?#].*)?$/u.test(v) && !v.includes(":") ? v : null;
  }
}

function serialize(nodes: AnyNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === "text") {
      out.push(escText(node.data));
      continue;
    }
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
    const el = node as AnyNode & { name: string; attribs: Record<string, string>; children: AnyNode[] };
    const name = el.name.toLowerCase();
    if (DROP.has(name)) continue;
    const allowed = ALLOWED[name];
    if (!allowed) {
      serialize(el.children, out);
      continue;
    }
    const attrs: string[] = [];
    for (const attr of allowed) {
      const raw = el.attribs[attr];
      if (raw === undefined) continue;
      let value: string | null = raw;
      if (attr === "href" || attr === "cite") value = safeUrl(raw, "href");
      else if (attr === "src") value = safeUrl(raw, "src");
      else if (attr === "target") value = raw === "_blank" ? "_blank" : null;
      else if (["width", "height", "colspan", "rowspan", "start"].includes(attr)) value = /^\d{1,5}$/.test(raw) ? raw : null;
      if (value !== null) attrs.push(` ${attr}="${escAttr(value)}"`);
    }
    // A new tab must not hand the opener to the linked site.
    if (name === "a" && el.attribs.target === "_blank") {
      const rel = new Set((el.attribs.rel ?? "").split(/\s+/).filter(Boolean));
      rel.add("noopener");
      const i = attrs.findIndex((a) => a.startsWith(" rel="));
      if (i >= 0) attrs.splice(i, 1);
      attrs.push(` rel="${escAttr([...rel].join(" "))}"`);
    }
    if (name === "img" && !attrs.some((a) => a.startsWith(" src="))) continue;
    out.push(`<${name}${attrs.join("")}>`);
    if (VOID.has(name)) continue;
    serialize(el.children, out);
    out.push(`</${name}>`);
  }
}

/** Sanitised HTML of a fragment or document body. */
export function sanitizeHtml(html: string): string {
  const $ = cheerio.load(html);
  const out: string[] = [];
  serialize($("body").get(0)?.children ?? ($.root().get(0)?.children as AnyNode[]) ?? [], out);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- structure

export type ContentStructure = {
  text: string;
  paragraphs: string[];
  headings: Array<{ level: number; text: string }>;
  firstParagraph: string;
  links: Array<{ href: string; text: string }>;
  images: Array<{ src: string; alt: string | null }>;
};

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function textOf($: cheerio.CheerioAPI, el: AnyNode): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === "text") parts.push(n.data);
    else if ("children" in n) for (const c of n.children as AnyNode[]) walk(c);
  };
  walk(el);
  return collapse(parts.join(" "));
}

export function structure(html: string): ContentStructure {
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();
  const headings: ContentStructure["headings"] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = collapse($(el).text());
    if (text && "tagName" in el) headings.push({ level: Number(el.tagName.slice(1)), text });
  });
  const paragraphs: string[] = [];
  $("p, li, blockquote, td, dd").each((_, el) => {
    // Nested blocks (a <p> in an <li>) are counted once, at the innermost level.
    if ($(el).find("p, li").length) return;
    const text = textOf($, el);
    if (text) paragraphs.push(text);
  });
  const links: ContentStructure["links"] = [];
  $("a[href]").each((_, el) => {
    links.push({ href: ($(el).attr("href") ?? "").trim(), text: collapse($(el).text()) });
  });
  const images: ContentStructure["images"] = [];
  $("img").each((_, el) => {
    const alt = $(el).attr("alt");
    images.push({ src: ($(el).attr("src") ?? "").trim(), alt: alt === undefined ? null : collapse(alt) });
  });
  const body = $("body").get(0);
  const blocks: string[] = [];
  // Block boundaries become line breaks so sentences never run across paragraphs.
  $("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, dd, dt, figcaption, pre").each((_, el) => {
    if ($(el).find("p, li").length) return;
    const t = textOf($, el);
    if (t) blocks.push(t);
  });
  const text = blocks.length ? blocks.join("\n") : body ? textOf($, body) : "";
  return { text, paragraphs, headings, firstParagraph: paragraphs[0] ?? "", links, images };
}

// ---------------------------------------------------------------- import

export type ImportedPage = {
  title: string | null;
  h1: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  lang: string | null;
  canonical: string | null;
  body: string;
};

const CONTENT_SELECTORS = [
  "article .entry-content",
  "article .post-content",
  ".entry-content",
  ".post-content",
  ".article-content",
  ".single-content",
  "[itemprop='articleBody']",
  "article",
  "main",
  "[role='main']",
  "#content",
  ".content",
];

/**
 * The main content of a page: a CMS's known content container when there is
 * one, otherwise the block with the most paragraph text (text density), which
 * leaves navigation, sidebars and footers out. Relative links and images are
 * made absolute against the page, then everything is sanitised.
 */
export function extractMainContent(html: string, pageUrl: string): ImportedPage {
  const $ = cheerio.load(html);
  const metaTitle = collapse($("head > title").first().text()) || null;
  const metaDescription =
    collapse(
      $("meta[name]")
        .filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === "description")
        .first()
        .attr("content") ?? "",
    ) || null;
  const lang = ($("html").attr("lang") ?? "").trim() || null;
  const canonicalHref = $("link[rel~='canonical']").first().attr("href");
  let canonical: string | null = null;
  try {
    canonical = canonicalHref ? new URL(canonicalHref, pageUrl).toString() : null;
  } catch {
    canonical = null;
  }
  $("script, style, noscript, template, nav, header, footer, aside, form, iframe").remove();
  $("[class*='sidebar'], [class*='comment'], [id*='comment'], [class*='share'], [class*='related'], [class*='breadcrumb']").remove();

  let root: ReturnType<typeof $> | null = null;
  for (const sel of CONTENT_SELECTORS) {
    const found = $(sel).first();
    if (found.length && collapse(found.text()).length > 200) {
      root = found;
      break;
    }
  }
  if (!root) {
    let best: { el: ReturnType<typeof $>; score: number } | null = null;
    $("div, section, td").each((_, el) => {
      const $el = $(el);
      const score = $el
        .children("p")
        .toArray()
        .reduce((sum, p) => sum + collapse($(p).text()).length, 0);
      if (score > (best?.score ?? 0)) best = { el: $el, score };
    });
    root = (best as { el: ReturnType<typeof $> } | null)?.el ?? $("body");
  }
  const h1 = collapse(root.find("h1").first().text()) || collapse($("h1").first().text()) || null;
  root.find("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    try {
      if (!href.startsWith("#")) $(el).attr("href", new URL(href, pageUrl).toString());
    } catch {
      $(el).removeAttr("href");
    }
  });
  root.find("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src") || "";
    try {
      if (src && !src.startsWith("data:")) $(el).attr("src", new URL(src, pageUrl).toString());
      else $(el).remove();
    } catch {
      $(el).remove();
    }
  });
  // The H1 is the document title; the body starts after it.
  root.find("h1").first().remove();
  return { title: h1 ?? metaTitle, h1, metaTitle, metaDescription, lang, canonical, body: sanitizeHtml(root.html() ?? "") };
}
