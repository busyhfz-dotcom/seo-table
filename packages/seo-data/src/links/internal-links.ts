/**
 * Internal linking from the latest scan's link graph (page_details.links).
 *
 * - Graph: every crawled page that answered 200 is a node; each followable
 *   internal link is an edge, with a link to a redirecting URL credited to
 *   where the redirect ends (as search engines consolidate it). nofollow links
 *   and links to pages the crawl never reached are left out.
 * - Equity: PageRank over that graph (pagerank.ts), 0–100 relative to the
 *   strongest page — an estimate of the site's own link structure only.
 * - Important pages: Search Console clicks over the last 28 days. Without
 *   Search Console only orphans are flagged, and importance says "unknown".
 * - Orphan: an indexable page no crawled page links to (found via the sitemap
 *   or a canonical); weakly linked: an important page with at most two linking
 *   pages or an equity score under 10.
 * - Suggestions: for each orphan/weak page, pages that share its topic (the
 *   meaningful words of title, H1, H2/H3 and top queries; Jaccard overlap),
 *   do not link to it yet, and carry equity to pass on. Anchor candidates are
 *   the target's own top queries, H1 and title — the words people search it by.
 */
import { NotFound } from "@seo/core";
import { withDeps, type Deps } from "../deps.js";
import { h1Of, key, latestCrawl, titleWithoutBrand, type SiteCrawl, type SitePage } from "../site.js";
import { cachedGsc } from "../content/context.js";
import { topicTerms, type Lang } from "../content/text.js";
import { pageRank, type Graph } from "./pagerank.js";

export type LinkedPage = {
  url: string;
  title: string | null;
  indexable: boolean;
  depth: number | null;
  inlinks: number;
  outlinks: number;
  equity: number;
  clicks: number | null;
};

export type LinkSuggestion = {
  source: { url: string; title: string | null; equity: number };
  target: { url: string; title: string | null; clicks: number | null };
  relevance: number;
  anchors: Array<{ text: string; source: "gsc" | "h1" | "title" }>;
  reason: "orphan" | "weak" | "related";
};

type Unavailable = { status: "no_scan" | "needs_rescan" };

type Model = {
  crawl: SiteCrawl;
  nodes: SitePage[];
  inbound: Map<string, Map<string, string[]>>;
  outbound: Map<string, Map<string, string>>;
  equity: Map<string, number>;
  clicks: Map<string, number> | null;
  queries: Map<string, Array<{ query: string; clicks: number; impressions: number }>> | null;
  topics: Map<string, Set<string>>;
  lang: Lang;
  gscPeriod: { from: string; to: string } | null;
  nofollowLinks: number;
  homepage: string;
};

function resolveTarget(crawl: SiteCrawl, url: string): string | null {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const page = crawl.byUrl.get(current);
    if (!page) return null;
    if (page.statusCode === 200) return current;
    if (page.statusCode >= 300 && page.statusCode < 400 && page.redirectTarget) {
      current = page.redirectTarget;
      continue;
    }
    return null;
  }
  return null;
}

async function model(projectId: string, baseUrl: string, locale: string, deps: Deps): Promise<Model | Unavailable> {
  const crawl = await latestCrawl(projectId);
  if (!crawl) return { status: "no_scan" };
  if (!crawl.hasDetails) return { status: "needs_rescan" };
  const nodes = crawl.pages.filter((p) => p.statusCode === 200);
  const inbound = new Map<string, Map<string, string[]>>();
  const outbound = new Map<string, Map<string, string>>();
  const edges: Graph["edges"] = new Map();
  let nofollowLinks = 0;
  for (const page of nodes) {
    const out = new Map<string, string>();
    for (const link of page.details?.links ?? []) {
      if (link.nf) {
        nofollowLinks++;
        continue;
      }
      const target = resolveTarget(crawl, link.u);
      if (!target || target === page.normalizedUrl) continue;
      if (!out.has(target)) out.set(target, link.a);
      const from = inbound.get(target) ?? new Map<string, string[]>();
      const anchors = from.get(page.normalizedUrl) ?? [];
      if (link.a && !anchors.includes(link.a) && anchors.length < 5) anchors.push(link.a);
      from.set(page.normalizedUrl, anchors);
      inbound.set(target, from);
    }
    outbound.set(page.normalizedUrl, out);
    edges.set(page.normalizedUrl, new Set(out.keys()));
  }
  const pr = pageRank({ nodes: nodes.map((p) => p.normalizedUrl), edges });
  const gsc = await cachedGsc(projectId, deps);
  const clicks = gsc ? new Map([...gsc.clicks].map(([u, c]) => [u, c.clicks])) : null;
  const lang: Lang = locale.startsWith("en") ? "en" : "fa";
  const topics = new Map<string, Set<string>>();
  for (const p of nodes) {
    const parts = [p.title ?? "", h1Of(p) ?? "", ...(p.details?.headings ?? []).filter((h) => h.l >= 2 && h.l <= 3).map((h) => h.t)];
    for (const q of gsc?.queries.get(p.normalizedUrl)?.slice(0, 5) ?? []) parts.push(q.query);
    topics.set(p.normalizedUrl, topicTerms(parts.join(" \n "), lang));
  }
  return {
    crawl,
    nodes,
    inbound,
    outbound,
    equity: pr.score,
    clicks,
    queries: gsc?.queries ?? null,
    topics,
    lang,
    gscPeriod: gsc ? { from: gsc.from, to: gsc.to } : null,
    nofollowLinks,
    homepage: key(baseUrl),
  };
}

function summary(m: Model, p: SitePage): LinkedPage {
  return {
    url: p.url,
    title: p.title,
    indexable: p.indexable,
    depth: p.depth,
    inlinks: m.inbound.get(p.normalizedUrl)?.size ?? 0,
    outlinks: m.outbound.get(p.normalizedUrl)?.size ?? 0,
    equity: m.equity.get(p.normalizedUrl) ?? 0,
    clicks: m.clicks ? (m.clicks.get(p.normalizedUrl) ?? 0) : null,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function anchorsFor(m: Model, p: SitePage): LinkSuggestion["anchors"] {
  const out: LinkSuggestion["anchors"] = [];
  const seen = new Set<string>();
  const push = (text: string | null, source: "gsc" | "h1" | "title") => {
    const t = text?.replace(/\s+/g, " ").trim();
    if (!t || [...t].length > 80 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({ text: t, source });
  };
  for (const q of m.queries?.get(p.normalizedUrl)?.slice(0, 3) ?? []) push(q.query, "gsc");
  push(h1Of(p), "h1");
  push(titleWithoutBrand(p.title), "title");
  return out.slice(0, 4);
}

const MIN_RELEVANCE = 0.1;

function sourcesFor(m: Model, target: SitePage, reason: LinkSuggestion["reason"], limit: number): LinkSuggestion[] {
  const tTopics = m.topics.get(target.normalizedUrl) ?? new Set<string>();
  const linkedFrom = m.inbound.get(target.normalizedUrl);
  const candidates: LinkSuggestion[] = [];
  for (const source of m.nodes) {
    if (source.normalizedUrl === target.normalizedUrl || !source.indexable || !source.details) continue;
    if (linkedFrom?.has(source.normalizedUrl)) continue;
    const relevance = jaccard(m.topics.get(source.normalizedUrl) ?? new Set(), tTopics);
    if (relevance < MIN_RELEVANCE) continue;
    const equity = m.equity.get(source.normalizedUrl) ?? 0;
    candidates.push({
      source: { url: source.url, title: source.title, equity },
      target: { url: target.url, title: target.title, clicks: m.clicks ? (m.clicks.get(target.normalizedUrl) ?? 0) : null },
      relevance: Math.round(relevance * 100) / 100,
      anchors: anchorsFor(m, target),
      reason,
    });
  }
  // Relevance first; equity decides between similarly relevant sources.
  return candidates.sort((a, b) => b.relevance * (0.5 + b.source.equity / 100) - a.relevance * (0.5 + a.source.equity / 100)).slice(0, limit);
}

export type SiteLinkReport =
  | Unavailable
  | {
      status: "ok";
      runId: string;
      scannedAt: string | null;
      importance: "gsc" | "unknown";
      gscPeriod: { from: string; to: string } | null;
      totals: { pages: number; links: number; nofollowLinks: number; orphans: number; weak: number };
      /** Share of all link equity held by the strongest 10% of pages (0–1). */
      topDecileShare: number;
      inlinkHistogram: Array<{ bucket: string; pages: number }>;
      pages: LinkedPage[];
      orphans: LinkedPage[];
      weak: LinkedPage[];
      suggestions: LinkSuggestion[];
    };

export async function siteLinks(
  projectId: string,
  project: { baseUrl: string; locale: string },
  partial: Partial<Deps> = {},
  opts: { limit?: number } = {},
): Promise<SiteLinkReport> {
  const m = await model(projectId, project.baseUrl, project.locale, withDeps(partial));
  if ("status" in m) return m;
  const indexable = m.nodes.filter((p) => p.indexable);
  const orphans = indexable.filter((p) => p.normalizedUrl !== m.homepage && !(m.inbound.get(p.normalizedUrl)?.size ?? 0));
  const orphanSet = new Set(orphans.map((p) => p.normalizedUrl));
  let weak: SitePage[] = [];
  if (m.clicks) {
    const important = indexable
      .filter((p) => (m.clicks!.get(p.normalizedUrl) ?? 0) > 0)
      .sort((a, b) => (m.clicks!.get(b.normalizedUrl) ?? 0) - (m.clicks!.get(a.normalizedUrl) ?? 0))
      .slice(0, 50);
    weak = important.filter(
      (p) => !orphanSet.has(p.normalizedUrl) && p.normalizedUrl !== m.homepage && ((m.inbound.get(p.normalizedUrl)?.size ?? 0) <= 2 || (m.equity.get(p.normalizedUrl) ?? 0) < 10),
    );
  }
  const byClicks = (a: SitePage, b: SitePage) => (m.clicks?.get(b.normalizedUrl) ?? 0) - (m.clicks?.get(a.normalizedUrl) ?? 0);
  const targets: Array<[SitePage, LinkSuggestion["reason"]]> = [
    ...weak.sort(byClicks).map((p) => [p, "weak"] as [SitePage, LinkSuggestion["reason"]]),
    ...orphans.sort(byClicks).map((p) => [p, "orphan"] as [SitePage, LinkSuggestion["reason"]]),
  ].slice(0, 40);
  const suggestions = targets.flatMap(([p, reason]) => sourcesFor(m, p, reason, 3)).slice(0, opts.limit ?? 100);

  const ranks = indexable.map((p) => m.equity.get(p.normalizedUrl) ?? 0).sort((a, b) => b - a);
  const total = ranks.reduce((s, r) => s + r, 0);
  const top = ranks.slice(0, Math.max(1, Math.ceil(ranks.length / 10))).reduce((s, r) => s + r, 0);
  const buckets: Array<[string, (n: number) => boolean]> = [
    ["0", (n) => n === 0],
    ["1", (n) => n === 1],
    ["2-5", (n) => n >= 2 && n <= 5],
    ["6-20", (n) => n >= 6 && n <= 20],
    ["21+", (n) => n > 20],
  ];
  const inCounts = indexable.map((p) => m.inbound.get(p.normalizedUrl)?.size ?? 0);
  const pages = m.nodes.map((p) => summary(m, p)).sort((a, b) => b.equity - a.equity);
  return {
    status: "ok",
    runId: m.crawl.runId,
    scannedAt: m.crawl.finishedAt?.toISOString() ?? null,
    importance: m.clicks ? "gsc" : "unknown",
    gscPeriod: m.gscPeriod,
    totals: {
      pages: m.nodes.length,
      links: [...m.outbound.values()].reduce((s, o) => s + o.size, 0),
      nofollowLinks: m.nofollowLinks,
      orphans: orphans.length,
      weak: weak.length,
    },
    topDecileShare: total ? Math.round((top / total) * 1000) / 1000 : 0,
    inlinkHistogram: buckets.map(([bucket, f]) => ({ bucket, pages: inCounts.filter(f).length })),
    pages: pages.slice(0, 500),
    orphans: orphans.map((p) => summary(m, p)),
    weak: weak.map((p) => summary(m, p)),
    suggestions,
  };
}

export type PageLinkReport =
  | Unavailable
  | {
      status: "ok";
      page: LinkedPage;
      inbound: Array<{ url: string; title: string | null; anchors: string[]; equity: number }>;
      outbound: Array<{ url: string; title: string | null; anchor: string }>;
      /** Pages that should link here. */
      linkFrom: LinkSuggestion[];
      /** Related pages this page could link to. */
      linkTo: LinkSuggestion[];
    };

export async function pageLinks(
  projectId: string,
  project: { baseUrl: string; locale: string },
  url: string,
  partial: Partial<Deps> = {},
): Promise<PageLinkReport> {
  const m = await model(projectId, project.baseUrl, project.locale, withDeps(partial));
  if ("status" in m) return m;
  const k = resolveTarget(m.crawl, key(url));
  const page = k ? m.nodes.find((p) => p.normalizedUrl === k) : undefined;
  if (!page) throw new NotFound("That page is not in the latest scan");
  const inbound = [...(m.inbound.get(page.normalizedUrl) ?? new Map<string, string[]>())].map(([from, anchors]) => {
    const p = m.crawl.byUrl.get(from);
    return { url: p?.url ?? from, title: p?.title ?? null, anchors, equity: m.equity.get(from) ?? 0 };
  });
  const outbound = [...(m.outbound.get(page.normalizedUrl) ?? new Map<string, string>())].map(([to, anchor]) => {
    const p = m.crawl.byUrl.get(to);
    return { url: p?.url ?? to, title: p?.title ?? null, anchor };
  });
  const isOrphan = inbound.length === 0 && page.normalizedUrl !== m.homepage;
  const linkFrom = sourcesFor(m, page, isOrphan ? "orphan" : "related", 10);
  const pageTopics = m.topics.get(page.normalizedUrl) ?? new Set<string>();
  const linkedTo = m.outbound.get(page.normalizedUrl) ?? new Map();
  const linkTo: LinkSuggestion[] = page.indexable && page.details
    ? m.nodes
        .filter((t) => t.indexable && t.normalizedUrl !== page.normalizedUrl && !linkedTo.has(t.normalizedUrl))
        .map((t) => ({ t, relevance: jaccard(pageTopics, m.topics.get(t.normalizedUrl) ?? new Set()) }))
        .filter((x) => x.relevance >= MIN_RELEVANCE)
        .sort((a, b) => b.relevance - a.relevance || (m.clicks?.get(b.t.normalizedUrl) ?? 0) - (m.clicks?.get(a.t.normalizedUrl) ?? 0))
        .slice(0, 10)
        .map(({ t, relevance }) => ({
          source: { url: page.url, title: page.title, equity: m.equity.get(page.normalizedUrl) ?? 0 },
          target: { url: t.url, title: t.title, clicks: m.clicks ? (m.clicks.get(t.normalizedUrl) ?? 0) : null },
          relevance: Math.round(relevance * 100) / 100,
          anchors: anchorsFor(m, t),
          reason: "related" as const,
        }))
    : [];
  return { status: "ok", page: summary(m, page), inbound, outbound, linkFrom, linkTo };
}
