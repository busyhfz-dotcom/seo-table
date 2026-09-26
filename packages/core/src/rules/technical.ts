/**
 * Technical rules: canonical, robots directives, sitemap, indexability.
 *
 * These are the rules whose fixes are dangerous. Anything that changes where a
 * URL resolves — a redirect, a URL change, a merge — is RESTRICTED, and the
 * database refuses to let it execute without an approval row.
 */
import { isAllowed } from "../robots.js";
import { isHtmlPage, type Finding, type Rule } from "./types.js";

export const canonicalMissing: Rule = {
  id: "rule.canonical.missing",
  category: "canonical",
  description: "Indexable page declares no canonical URL.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      if (!isHtmlPage(page)) continue;
      if (page.canonical) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "WARNING",
        title: "Page has no canonical URL",
        url: page.normalizedUrl,
        evidence: { indexable: page.indexable },
        fix: {
          action: "CANONICAL_FIX",
          risk: "SENSITIVE",
          title: "Add a self-referencing canonical",
          rationale:
            "Without a canonical, parameter and duplicate variants of this URL can be indexed instead of it.",
          change: {
            url: page.normalizedUrl,
            field: "canonical",
            before: null,
            after: page.normalizedUrl,
          },
        },
      });
    }
    return out;
  },
};

export const canonicalBroken: Rule = {
  id: "rule.canonical.broken",
  category: "canonical",
  description: "Canonical points at a URL that errors, redirects, or could not be checked.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      const target = page.canonical;
      if (!target || target === page.normalizedUrl) continue;
      const targetPage = ctx.byUrl.get(target);
      if (!targetPage) {
        // The crawler fetches out-of-crawl canonical targets within a budget; one
        // still missing (robots.txt, budget) was never observed, so it is not
        // called broken — only reported as unverified, with nothing to fix yet.
        if (!sameHost(target, ctx.project.baseUrl)) continue;
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "INFO",
          title: "Canonical target could not be verified",
          groupKey: "unverified_target",
          url: page.normalizedUrl,
          evidence: { canonical: target, reason: "target_not_fetched" },
        });
        continue;
      }
      const broken =
        targetPage.statusCode >= 400 ||
        targetPage.statusCode === 0 ||
        (targetPage.statusCode >= 300 && targetPage.statusCode < 400);
      if (!broken) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "CRITICAL",
        title: "Canonical points to a page that cannot be indexed",
        groupKey: "broken_target",
        url: page.normalizedUrl,
        evidence: {
          canonical: target,
          targetStatus: targetPage.statusCode,
          reason: "target_error_or_redirect",
        },
        fix: {
          action: "CANONICAL_FIX",
          risk: "SENSITIVE",
          title: "Point the canonical at this page",
          rationale:
            "The declared canonical cannot be indexed, so this page's signals are being sent nowhere.",
          change: {
            url: page.normalizedUrl,
            field: "canonical",
            before: target,
            after: page.normalizedUrl,
          },
        },
      });
    }
    return out;
  },
};

export const noindexOnLinkedPage: Rule = {
  id: "rule.index.noindex_linked",
  category: "indexability",
  description: "A page the site links to internally is marked noindex.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      if (page.statusCode !== 200) continue;
      const reason = page.noindexReason;
      if (!reason || !["meta_noindex", "meta_none"].includes(reason)) continue;
      if (page.internalLinksIn === 0) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "CRITICAL",
        title: "Linked page is blocked from indexing",
        url: page.normalizedUrl,
        evidence: {
          robotsMeta: page.robotsMeta,
          xRobotsTag: page.xRobotsTag,
          internalLinksIn: page.internalLinksIn,
        },
        fix: {
          action: "ROBOTS_FIX",
          risk: "SENSITIVE",
          title: "Remove the noindex directive",
          rationale:
            "The site links to this page internally, which means it is meant to be found, but the directive hides it.",
          change: {
            url: page.normalizedUrl,
            field: "meta_robots",
            before: page.robotsMeta ?? page.xRobotsTag ?? "noindex",
            after: "index, follow",
          },
        },
      });
    }
    return out;
  },
};

export const robotsTxtBlocksSitemapUrl: Rule = {
  id: "rule.robots.blocks_sitemap_url",
  category: "robots",
  description: "A URL listed in the sitemap is disallowed by robots.txt.",
  run(ctx) {
    const out: Finding[] = [];
    for (const url of ctx.sitemapUrls) {
      if (isAllowed(ctx.robots, url, ctx.userAgent)) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "SERIOUS",
        title: "Sitemap lists a URL that robots.txt blocks",
        url,
        evidence: { source: "sitemap", note: "The two files give crawlers opposite instructions." },
      });
    }
    return out;
  },
};

export const robotsTxtMissing: Rule = {
  id: "rule.robots.missing",
  category: "robots",
  description: "The site serves no robots.txt.",
  run(ctx) {
    if (!ctx.robots.missing) return [];
    return [
      {
        ruleId: this.id,
        category: this.category,
        severity: "INFO",
        title: "Site has no robots.txt",
        url: new URL("/robots.txt", ctx.project.baseUrl).toString(),
        evidence: {
          note: "Everything is crawlable by default; a robots.txt lets you point crawlers at the sitemap.",
        },
      },
    ];
  },
};

export const robotsTxtUnreachable: Rule = {
  id: "rule.robots.unreachable",
  category: "robots",
  description: "robots.txt answered with a server error or could not be fetched, so crawlers stop.",
  run(ctx) {
    if (!ctx.robots.unreachable) return [];
    return [
      {
        ruleId: this.id,
        category: this.category,
        severity: "CRITICAL",
        title: "robots.txt could not be fetched",
        url: new URL("/robots.txt", ctx.project.baseUrl).toString(),
        evidence: {
          note:
            "A 5xx or network error on robots.txt makes search engines treat the whole site as disallowed. Nothing else was crawled.",
        },
      },
    ];
  },
};

export const sitemapMissing: Rule = {
  id: "rule.sitemap.missing",
  category: "sitemap",
  description: "No sitemap was found via robots.txt or /sitemap.xml.",
  run(ctx) {
    // With robots.txt unreachable no sitemap was requested, so absence proves nothing.
    if (ctx.sitemapUrls.size > 0 || ctx.robots.unreachable) return [];
    return [
      {
        ruleId: this.id,
        category: this.category,
        severity: "SERIOUS",
        title: "No sitemap found",
        url: new URL("/sitemap.xml", ctx.project.baseUrl).toString(),
        evidence: { checked: ["robots.txt Sitemap:", "/sitemap.xml"] },
      },
    ];
  },
};

export const pageNotInSitemap: Rule = {
  id: "rule.sitemap.page_missing",
  category: "sitemap",
  description: "An indexable page is absent from the sitemap.",
  run(ctx) {
    if (ctx.sitemapUrls.size === 0) return []; // sitemapMissing already covers this
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      if (page.statusCode !== 200 || !page.indexable) continue;
      if (page.inSitemap) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "INFO",
        title: "Indexable page is not in the sitemap",
        url: page.normalizedUrl,
        evidence: { depth: page.depth },
        fix: {
          action: "SITEMAP_ADD",
          risk: "LOW",
          title: "Add the page to the sitemap",
          rationale: "The page is indexable and linked, but crawlers are not told about it.",
          change: {
            url: page.normalizedUrl,
            field: "sitemap",
            before: null,
            after: page.normalizedUrl,
          },
        },
      });
    }
    return out;
  },
};

export const sitemapUrlNotIndexable: Rule = {
  id: "rule.sitemap.url_not_indexable",
  category: "sitemap",
  description: "The sitemap lists a URL that errors, redirects, or is noindex.",
  run(ctx) {
    const out: Finding[] = [];
    for (const url of ctx.sitemapUrls) {
      const page = ctx.byUrl.get(url);
      if (!page) continue;
      if (page.statusCode === 200 && page.indexable) continue;
      // Sitemaps may list PDFs and other documents; they are not HTML pages to judge.
      if (page.noindexReason === "non_html") continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "SERIOUS",
        title: "Sitemap lists a URL that cannot be indexed",
        groupKey: page.statusCode >= 400 ? "error" : (page.noindexReason ?? "not_indexable"),
        url,
        evidence: { statusCode: page.statusCode, reason: page.noindexReason },
      });
    }
    return out;
  },
};

export const httpError: Rule = {
  id: "rule.index.http_error",
  category: "indexability",
  description: "A crawled URL returned an error status or failed to respond.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      if (page.statusCode === 0) {
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "CRITICAL",
          title: "URL did not respond",
          groupKey: "unreachable",
          url: page.normalizedUrl,
          evidence: { internalLinksIn: page.internalLinksIn },
        });
        continue;
      }
      if (page.statusCode < 400) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: page.statusCode >= 500 ? "CRITICAL" : "SERIOUS",
        title: `URL returns HTTP ${page.statusCode}`,
        groupKey: String(page.statusCode),
        url: page.normalizedUrl,
        evidence: { statusCode: page.statusCode, internalLinksIn: page.internalLinksIn },
      });
    }
    return out;
  },
};

export const redirectChainRule: Rule = {
  id: "rule.index.redirect_chain",
  category: "indexability",
  description: "A URL redirects through more hops than necessary, or loops.",
  run(ctx) {
    const out: Finding[] = [];
    for (const page of ctx.pages) {
      if (!page.redirectTarget) continue;

      if (page.redirectLoop) {
        out.push({
          ruleId: this.id,
          category: this.category,
          severity: "CRITICAL",
          title: "Redirect loop",
          groupKey: "loop",
          url: page.normalizedUrl,
          evidence: { chain: page.redirectChain, statusCode: page.statusCode },
        });
        continue;
      }

      // chain includes the start, so hops = length - 1.
      const hops = Math.max(0, page.redirectChain.length - 1);
      if (hops <= ctx.thresholds.maxRedirectHops) continue;

      const destination = page.redirectChain[page.redirectChain.length - 1] ?? page.redirectTarget;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "WARNING",
        title: `Redirect chain of ${hops} hops`,
        groupKey: "chain",
        url: page.normalizedUrl,
        evidence: { hops, chain: page.redirectChain.slice(0, 8), destination },
        fix: {
          action: "REDIRECT",
          // Changing where a URL resolves is never automatic.
          risk: "RESTRICTED",
          title: "Collapse the chain to a single redirect",
          rationale: "Each hop loses signal and slows the first byte for visitors and crawlers.",
          change: {
            url: page.normalizedUrl,
            field: "redirect",
            before: page.redirectChain.join(" \u2192 "),
            after: destination,
          },
        },
      });
    }
    return out;
  },
};

export const redirectInSitemap: Rule = {
  id: "rule.sitemap.redirect",
  category: "sitemap",
  description: "The sitemap lists a URL that redirects instead of the destination.",
  run(ctx) {
    const out: Finding[] = [];
    for (const url of ctx.sitemapUrls) {
      const page = ctx.byUrl.get(url);
      if (!page?.redirectTarget) continue;
      out.push({
        ruleId: this.id,
        category: this.category,
        severity: "WARNING",
        title: "Sitemap lists a redirecting URL",
        url,
        evidence: { statusCode: page.statusCode, target: page.redirectTarget },
      });
    }
    return out;
  },
};

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

export const TECHNICAL_RULES: Rule[] = [
  canonicalMissing,
  canonicalBroken,
  noindexOnLinkedPage,
  robotsTxtMissing,
  robotsTxtUnreachable,
  robotsTxtBlocksSitemapUrl,
  sitemapMissing,
  pageNotInSitemap,
  sitemapUrlNotIndexable,
  httpError,
  redirectChainRule,
  redirectInSitemap,
];
