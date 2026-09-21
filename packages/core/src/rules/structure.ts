/**
 * Site-structure rules: internal linking, depth, duplicate content.
 *
 * A page merge is the most destructive action the product can propose, so it is
 * RESTRICTED: it is only ever a proposal, and only a human can release it.
 */
import type { Finding, Rule, RuleContext } from "./types.js";

export const orphanPage: Rule = {
  id: "rule.links.orphan",
  category: "internal_links",
  description: "An indexable page has no internal links pointing at it.",
  run(ctx) {
    const out: Finding[] = [];
    const home = normalizeHome(ctx);
    for (const page of ctx.pages) {
      if (page.statusCode !== 200 || !page.indexable) continue;
      if (page.normalizedUrl === home) continue;
      if (page.internalLinksIn > 0) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "SERIOUS",
        title: "Page has no internal links pointing to it",
        url: page.normalizedUrl,
        evidence: { inSitemap: page.inSitemap, depth: page.depth },
        fix: {
          action: "INTERNAL_LINK",
          risk: "SENSITIVE",
          title: "Link to the page from a relevant parent",
          rationale:
            "Crawlers reach pages through links. An orphan is only discoverable through the sitemap, if at all.",
          change: {
            url: parentUrl(page.normalizedUrl) ?? home,
            field: "internal_link",
            before: null,
            after: page.normalizedUrl,
          },
        },
      });
    }
    return out;
  },
};

export const deadInternalLink: Rule = {
  id: "rule.links.dead_internal",
  category: "internal_links",
  description: "An internal link points at a URL that errors.",
  run(ctx) {
    const out: Finding[] = [];
    const reported = new Set<string>();
    for (const page of ctx.pages) {
      for (const link of page.links) {
        if (!link.internal) continue;
        const target = ctx.byUrl.get(link.url);
        if (!target) continue;
        if (target.statusCode !== 0 && target.statusCode < 400) continue;
        const key = `${page.normalizedUrl}→${link.url}`;
        if (reported.has(key)) continue;
        reported.add(key);
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "SERIOUS",
          title: "Internal link points to a broken URL",
          groupKey: link.url,
          url: page.normalizedUrl,
          evidence: { target: link.url, targetStatus: target.statusCode, anchor: link.anchor },
        });
      }
    }
    return out;
  },
};

export const excessiveDepth: Rule = {
  id: "rule.links.depth",
  category: "internal_links",
  description: "A page sits further from the home page than the configured depth.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      if (page.statusCode !== 200 || !page.indexable) continue;
      if (page.depth <= ctx.thresholds.maxDepth) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "INFO",
        title: `Page is ${page.depth} clicks from the home page`,
        url: page.normalizedUrl,
        evidence: { depth: page.depth, max: ctx.thresholds.maxDepth, internalLinksIn: page.internalLinksIn },
      });
    }
    return out;
  },
};

export const nofollowInternal: Rule = {
  id: "rule.links.nofollow_internal",
  category: "internal_links",
  description: "An internal link carries rel=nofollow, which wastes the link.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      for (const link of page.links) {
        if (!link.internal || !link.nofollow) continue;
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "INFO",
          title: "Internal link is nofollowed",
          groupKey: link.url,
          url: page.normalizedUrl,
          evidence: { target: link.url, anchor: link.anchor },
        });
      }
    }
    return out;
  },
};

export const duplicateContent: Rule = {
  id: "rule.duplicate.content",
  category: "duplicate",
  description: "Two or more indexable pages have identical visible text.",
  run(ctx) {
    const groups = new Map<string, typeof ctx.pages>();
    for (const page of ctx.pages) {
      if (page.statusCode !== 200 || !page.indexable) continue;
      if (!page.textHash || page.wordCount < 50) continue;
      const list = groups.get(page.textHash) ?? [];
      list.push(page);
      groups.set(page.textHash, list);
    }

    const out: Finding[] = [];
    for (const [hash, pages] of groups) {
      if (pages.length < 2) continue;
      // The shallowest, best-linked page is the natural survivor.
      const sorted = [...pages].sort(
        (a, b) => a.depth - b.depth || b.internalLinksIn - a.internalLinksIn,
      );
      const keep = sorted[0]!;
      for (const page of sorted) {
        const isKeeper = page.normalizedUrl === keep.normalizedUrl;
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "SERIOUS",
          title: `Identical content on ${pages.length} URLs`,
          groupKey: hash.slice(0, 32),
          url: page.normalizedUrl,
          evidence: {
            duplicateOf: keep.normalizedUrl,
            group: sorted.map((p) => p.normalizedUrl).slice(0, 10),
            wordCount: page.wordCount,
            role: isKeeper ? "canonical_candidate" : "duplicate",
          },
          ...(isKeeper
            ? {}
            : {
                fix: {
                  action: "PAGE_MERGE" as const,
                  // Merging pages destroys a URL. Human approval, always.
                  risk: "RESTRICTED" as const,
                  title: "Merge into the primary page",
                  rationale: `This URL duplicates ${keep.normalizedUrl}, so the two compete for the same query.`,
                  change: {
                    url: page.normalizedUrl,
                    field: "merge_target",
                    before: `${page.normalizedUrl} + ${keep.normalizedUrl}`,
                    after: `${keep.normalizedUrl} (301 ← ${page.normalizedUrl})`,
                  },
                },
              }),
        });
      }
    }
    return out;
  },
};

export const numericSlug: Rule = {
  id: "rule.url.numeric_slug",
  category: "url",
  description: "A URL identifies the page only by a number, with no words.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      if (page.statusCode !== 200 || !page.indexable) continue;
      let segment: string;
      try {
        const parts = new URL(page.normalizedUrl).pathname.split("/").filter(Boolean);
        segment = parts[parts.length - 1] ?? "";
      } catch {
        continue;
      }
      if (!segment || !/^\d+$/.test(segment.replace(/\.(html?|php)$/i, ""))) continue;
      const words = (page.h1s[0] ?? page.title ?? "").trim();
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "INFO",
        title: "URL has no descriptive slug",
        url: page.normalizedUrl,
        evidence: { segment, h1: page.h1s[0] ?? null },
        ...(words
          ? {
              fix: {
                action: "URL_CHANGE" as const,
                // Changing a URL breaks every existing link to it.
                risk: "RESTRICTED" as const,
                title: "Move to a descriptive slug",
                rationale: "The slug carries no words, so neither people nor search engines learn anything from it.",
                change: {
                  url: page.normalizedUrl,
                  field: "slug",
                  before: page.normalizedUrl,
                  after: withSlug(page.normalizedUrl, slugify(words), segment),
                },
              },
            }
          : {}),
      });
    }
    return out;
  },
};

function normalizeHome(ctx: RuleContext): string {
  try {
    const u = new URL(ctx.project.baseUrl);
    u.pathname = "/";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "") || u.toString();
  } catch {
    return ctx.project.baseUrl;
  }
}

function parentUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length <= 1) return null;
    u.pathname = `/${parts.slice(0, -1).join("/")}`;
    return u.toString();
  } catch {
    return null;
  }
}

/** Slug that keeps Persian and Arabic letters instead of stripping them to nothing. */
export function slugify(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‌‎‏]/g, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function withSlug(url: string, slug: string, oldSegment: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    parts[parts.length - 1] = `${slug}-${oldSegment}`;
    u.pathname = `/${parts.join("/")}`;
    return u.toString();
  } catch {
    return url;
  }
}

export const STRUCTURE_RULES: Rule[] = [
  orphanPage,
  deadInternalLink,
  excessiveDepth,
  nofollowInternal,
  duplicateContent,
  numericSlug,
];
