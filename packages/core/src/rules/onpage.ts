/**
 * On-page rules: title, meta description, headings, image alt text.
 *
 * Every rule that can be fixed deterministically carries a ProposedFix with the
 * exact `after` value, so the Auto Fixes screen shows a real diff rather than a
 * suggestion to go and think about it.
 */
import { brandOf, trimToLength, type Finding, type Rule, type RuleContext } from "./types.js";

/** Only pages a search engine could actually index are worth reporting on. */
function indexablePages(ctx: RuleContext) {
  return ctx.pages.filter((p) => p.statusCode === 200 && p.indexable);
}

export const titleMissing: Rule = {
  id: "rule.title.missing",
  category: "title",
  description: "Indexable page has no <title> element, or it is empty.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of indexablePages(ctx)) {
      if (page.title && page.title.trim().length > 0) continue;
      const h1 = page.h1s[0]?.trim();
      const brand = brandOf(ctx);
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "CRITICAL",
        title: "Page has no title",
        url: page.normalizedUrl,
        evidence: { titleLength: 0, h1: h1 ?? null },
        ...(h1
          ? {
              fix: {
                action: "TITLE_REWRITE" as const,
                // A title is what searchers see; a machine-written one is reviewed.
                risk: "SENSITIVE" as const,
                title: "Add a title built from the page's H1",
                rationale:
                  "The page has no title, so search engines invent one. The H1 already states the topic.",
                change: {
                  url: page.normalizedUrl,
                  field: "title",
                  before: null,
                  after: brand
                    ? trimToLength(`${h1} | ${brand}`, ctx.thresholds.titleMax)
                    : trimToLength(h1, ctx.thresholds.titleMax),
                },
              },
            }
          : {}),
      });
    }
    return out;
  },
};

export const titleLength: Rule = {
  id: "rule.title.length",
  category: "title",
  description: "Title is shorter or longer than the range search results display well.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of indexablePages(ctx)) {
      if (!page.title) continue;
      const len = page.titleLength;
      if (len >= ctx.thresholds.titleMin && len <= ctx.thresholds.titleMax) continue;
      const tooLong = len > ctx.thresholds.titleMax;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "WARNING",
        title: tooLong ? "Title is longer than search results show" : "Title is very short",
        groupKey: tooLong ? "too_long" : "too_short",
        url: page.normalizedUrl,
        evidence: { title: page.title, length: len, min: ctx.thresholds.titleMin, max: ctx.thresholds.titleMax },
        ...(tooLong
          ? {
              fix: {
                action: "TITLE_REWRITE" as const,
                risk: "SENSITIVE" as const,
                title: "Shorten the title to fit the search result",
                rationale: `The title is ${len} characters; results truncate near ${ctx.thresholds.titleMax}.`,
                change: {
                  url: page.normalizedUrl,
                  field: "title",
                  before: page.title,
                  after: trimToLength(page.title, ctx.thresholds.titleMax),
                },
              },
            }
          : {}),
      });
    }
    return out;
  },
};

export const titleDuplicate: Rule = {
  id: "rule.title.duplicate",
  category: "title",
  description: "Several indexable pages share one title, so results cannot be told apart.",
  run(ctx) {
    const groups = new Map<string, typeof ctx.pages>();
    for (const page of indexablePages(ctx)) {
      const key = page.title?.trim().toLowerCase();
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(page);
      groups.set(key, list);
    }

    const out: Finding[] = [];
    const brand = brandOf(ctx);
    for (const [key, pages] of groups) {
      if (pages.length < 2) continue;
      for (const page of pages) {
        const h1 = page.h1s[0]?.trim();
        const distinct = h1 && h1.toLowerCase() !== key ? h1 : lastPathSegment(page.normalizedUrl);
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "SERIOUS",
          title: `Duplicate title across ${pages.length} pages`,
          groupKey: key,
          url: page.normalizedUrl,
          evidence: { title: page.title, sharedWith: pages.length, urls: pages.slice(0, 10).map((p) => p.normalizedUrl) },
          ...(distinct
            ? {
                fix: {
                  action: "TITLE_REWRITE" as const,
                  risk: "SENSITIVE" as const,
                  title: "Give the page a title of its own",
                  rationale: `${pages.length} pages share this title, so they compete for the same result.`,
                  change: {
                    url: page.normalizedUrl,
                    field: "title",
                    before: page.title,
                    after: trimToLength(brand ? `${distinct} | ${brand}` : distinct, ctx.thresholds.titleMax),
                  },
                },
              }
            : {}),
        });
      }
    }
    return out;
  },
};

export const metaMissing: Rule = {
  id: "rule.meta.missing",
  category: "meta",
  description: "Indexable page has no meta description.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of indexablePages(ctx)) {
      if (page.metaDescription && page.metaDescription.trim()) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "WARNING",
        title: "Page has no meta description",
        url: page.normalizedUrl,
        evidence: { wordCount: page.wordCount },
      });
    }
    return out;
  },
};

export const metaLength: Rule = {
  id: "rule.meta.length",
  category: "meta",
  description: "Meta description is outside the length search results render.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of indexablePages(ctx)) {
      const desc = page.metaDescription;
      if (!desc) continue;
      const len = page.metaDescriptionLength;
      if (len >= ctx.thresholds.metaMin && len <= ctx.thresholds.metaMax) continue;
      const tooLong = len > ctx.thresholds.metaMax;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "WARNING",
        title: tooLong
          ? `Meta description longer than ${ctx.thresholds.metaMax} characters`
          : "Meta description is very short",
        groupKey: tooLong ? "too_long" : "too_short",
        url: page.normalizedUrl,
        evidence: { length: len, max: ctx.thresholds.metaMax, min: ctx.thresholds.metaMin },
        ...(tooLong
          ? {
              fix: {
                action: "META_REWRITE" as const,
                // Trimming an existing sentence keeps the author's words, so this
                // is the one text change the agent may make on its own.
                risk: "LOW" as const,
                title: "Trim the meta description",
                rationale: `It is ${len} characters; the rest is cut off in results.`,
                change: {
                  url: page.normalizedUrl,
                  field: "meta_description",
                  before: desc,
                  after: trimToLength(desc, ctx.thresholds.metaMax - 5),
                },
              },
            }
          : {}),
      });
    }
    return out;
  },
};

export const metaDuplicate: Rule = {
  id: "rule.meta.duplicate",
  category: "meta",
  description: "Several pages share one meta description.",
  run(ctx) {
    const groups = new Map<string, string[]>();
    for (const page of indexablePages(ctx)) {
      const key = page.metaDescription?.trim().toLowerCase();
      if (!key || key.length < 20) continue;
      groups.set(key, [...(groups.get(key) ?? []), page.normalizedUrl]);
    }
    const out: Finding[] = [];
    for (const [key, urls] of groups) {
      if (urls.length < 2) continue;
      for (const url of urls) {
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "WARNING",
          title: `Duplicate meta description across ${urls.length} pages`,
          groupKey: key.slice(0, 64),
          url,
          evidence: { sharedWith: urls.length, urls: urls.slice(0, 10) },
        });
      }
    }
    return out;
  },
};

export const h1Rules: Rule = {
  id: "rule.h1.structure",
  category: "structure",
  description: "Page is missing an H1, or has more than one.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of indexablePages(ctx)) {
      const h1s = page.h1s.filter((h) => h.trim().length > 0);
      if (h1s.length === 1) continue;
      const missing = h1s.length === 0;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: missing ? "SERIOUS" : "WARNING",
        title: missing ? "Page has no H1" : `Page has ${h1s.length} H1 elements`,
        groupKey: missing ? "missing" : "multiple",
        url: page.normalizedUrl,
        evidence: { count: h1s.length, h1s: h1s.slice(0, 5), title: page.title },
        ...(!missing && h1s.length > 1
          ? {
              fix: {
                action: "H1_FIX" as const,
                risk: "SENSITIVE" as const,
                title: "Keep one H1 and demote the rest to H2",
                rationale: "Multiple H1s leave the page's main topic ambiguous.",
                change: {
                  url: page.normalizedUrl,
                  field: "headings",
                  before: h1s.join(" | "),
                  after: `h1: ${h1s[0]} · h2: ${h1s.slice(1).join(" | ")}`,
                },
              },
            }
          : {}),
      });
    }
    return out;
  },
};

export const imageAlt: Rule = {
  id: "rule.alt.missing",
  category: "accessibility",
  description: "Images have no alt attribute at all (alt=\"\" is a valid opt-out and is not reported).",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of indexablePages(ctx)) {
      if (page.imagesMissingAlt === 0) continue;
      for (const img of page.imagesWithoutAlt) {
        const suggested = altFromContext(img.context, page.h1s[0] ?? page.title ?? "");
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "WARNING",
          title: "Image is missing alt text",
          url: page.normalizedUrl,
          evidence: { src: img.src, imagesMissingAlt: page.imagesMissingAlt, imagesTotal: page.imagesTotal },
          ...(suggested
            ? {
                fix: {
                  action: "ALT_TEXT" as const,
                  // Adding a missing attribute changes nothing a visitor reads.
                  risk: "LOW" as const,
                  title: "Describe the image",
                  rationale:
                    "The image has no alt attribute, so screen readers and image search have nothing to work with.",
                  change: {
                    url: page.normalizedUrl,
                    field: "img.alt",
                    before: null,
                    after: suggested,
                    selector: img.src,
                  },
                },
              }
            : {}),
        });
      }
    }
    return out;
  },
};

export const thinContent: Rule = {
  id: "rule.content.thin",
  category: "content",
  description: "Indexable page has very little text.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of indexablePages(ctx)) {
      if (page.wordCount >= ctx.thresholds.thinContentWords) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "INFO",
        title: `Page has fewer than ${ctx.thresholds.thinContentWords} words`,
        url: page.normalizedUrl,
        evidence: { wordCount: page.wordCount },
      });
    }
    return out;
  },
};

function lastPathSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    return last
      .replace(/\.(html?|php)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function altFromContext(context: string, fallback: string): string | null {
  const source = (context || fallback).replace(/\s+/g, " ").trim();
  if (!source) return null;
  return trimToLength(source, 100);
}

export const ONPAGE_RULES: Rule[] = [
  titleMissing,
  titleLength,
  titleDuplicate,
  metaMissing,
  metaLength,
  metaDuplicate,
  h1Rules,
  imageAlt,
  thinContent,
];
