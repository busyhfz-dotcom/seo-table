/**
 * What the content analyser compares a document with, gathered from real
 * sources only:
 *   - benchmark length: our pages that Search Console shows ranking (top 20)
 *     for queries containing the keyword, the tracked keyword's target page,
 *     and competitor pages sampled by our crawler whose title, H1 or H2s
 *     mention the keyword — each labelled with where it came from;
 *   - related terms: the Search Console queries of the document's page, or,
 *     without a page, the queries containing the keyword;
 *   - internal link targets: indexable pages of the latest scan, named by
 *     their top queries, H1 and title.
 * Search Console rows are read once per project and kept for ten minutes, so
 * re-analysing on every save does not spend the API quota.
 */
import { and, competitorSnapshots, competitors, db, eq, keywords, sql } from "@seo/db";
import { defaultDeps, withDeps, type Deps } from "../deps.js";
import { phraseKey } from "../text.js";
import { gscPages, h1Of, key, latestCrawl, projectById, titleWithoutBrand, type SiteCrawl } from "../site.js";
import type { AnalysisContext, BenchmarkPage, LinkTarget, RelatedQuery } from "./analyze.js";
import { containsPhrase, type Lang } from "./text.js";

const GSC_TTL_MS = 10 * 60_000;
const gscCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof gscPages>> }>();

export async function cachedGsc(projectId: string, deps: Deps) {
  // Only the production source is cached; a test's fake answers fresh every time.
  if (deps.gsc !== defaultDeps.gsc) return gscPages(projectId, deps);
  const hit = gscCache.get(projectId);
  if (hit && Date.now() - hit.at < GSC_TTL_MS) return hit.value;
  const value = await gscPages(projectId, deps);
  if (gscCache.size > 200) gscCache.clear();
  gscCache.set(projectId, { at: Date.now(), value });
  return value;
}

const MAX_LINK_TARGETS = 400;

export async function buildContext(
  projectId: string,
  doc: { targetKeyword: string | null; url: string | null; locale: string },
  partial: Partial<Deps> = {},
): Promise<AnalysisContext & { sources: { gsc: boolean; crawl: boolean; competitors: number } }> {
  const deps = withDeps(partial);
  const lang: Lang = doc.locale.startsWith("fa") ? "fa" : "en";
  const project = await projectById(projectId);
  const [crawl, gsc] = await Promise.all([latestCrawl(projectId), cachedGsc(projectId, deps)]);
  const host = new URL(project.baseUrl).hostname.toLowerCase();
  const siteHosts = [host, host.startsWith("www.") ? host.slice(4) : `www.${host}`];
  const phrase = doc.targetKeyword?.trim() || null;

  // ---- benchmark
  const benchmark: BenchmarkPage[] = [];
  const seen = new Set<string>();
  const addOurs = (url: string, source: BenchmarkPage["source"]) => {
    const k = key(url);
    const page = crawl?.byUrl.get(k);
    if (!page || seen.has(k) || page.statusCode !== 200 || (doc.url && key(doc.url) === k)) return;
    seen.add(k);
    benchmark.push({ url: page.url, words: page.wordCount, source });
  };
  if (phrase && gsc) {
    const ranked: Array<{ url: string; clicks: number; impressions: number }> = [];
    for (const [url, list] of gsc.queries) {
      const hits = list.filter((q) => q.position <= 20 && containsPhrase(q.query, phrase, lang));
      if (hits.length) ranked.push({ url, clicks: hits.reduce((s, q) => s + q.clicks, 0), impressions: hits.reduce((s, q) => s + q.impressions, 0) });
    }
    ranked.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    for (const r of ranked.slice(0, 5)) addOurs(r.url, "gsc");
  }
  if (phrase) {
    const tracked = await db
      .select({ targetUrl: keywords.targetUrl })
      .from(keywords)
      .where(and(eq(keywords.projectId, projectId), sql`lower(${keywords.phrase}) = ${phraseKey(phrase)}`));
    for (const t of tracked) if (t.targetUrl) addOurs(t.targetUrl, "tracked");
  }
  let competitorPages = 0;
  if (phrase) {
    const rows = await db
      .select({
        url: competitorSnapshots.url,
        domain: competitors.domain,
        title: competitorSnapshots.title,
        h1: competitorSnapshots.h1,
        headings: competitorSnapshots.headings,
        wordCount: competitorSnapshots.wordCount,
        statusCode: competitorSnapshots.statusCode,
      })
      .from(competitorSnapshots)
      .innerJoin(competitors, eq(competitors.id, competitorSnapshots.competitorId))
      .where(
        and(
          eq(competitors.projectId, projectId),
          eq(competitors.isSelf, false),
          sql`${competitorSnapshots.fetchedAt} = (SELECT max(s2.fetched_at) FROM competitor_snapshots s2 WHERE s2.competitor_id = ${competitorSnapshots.competitorId})`,
        ),
      );
    for (const r of rows) {
      if (r.statusCode !== 200 || r.wordCount <= 0) continue;
      const text = [r.title ?? "", ...(r.h1 ?? []), ...(r.headings?.h2 ?? [])].join(" \n ");
      if (!containsPhrase(text, phrase, lang)) continue;
      competitorPages++;
      if (competitorPages <= 10) benchmark.push({ url: r.url, words: r.wordCount, source: "competitor", domain: r.domain });
    }
  }

  // ---- related queries
  let relatedQueries: RelatedQuery[] | null = null;
  let relatedScope: AnalysisContext["relatedScope"] = null;
  if (gsc) {
    const own = doc.url ? gsc.queries.get(key(doc.url)) : undefined;
    if (own?.length) {
      relatedQueries = own.slice(0, 200).map(({ query, clicks, impressions }) => ({ query, clicks, impressions }));
      relatedScope = "page";
    } else if (phrase) {
      const agg = new Map<string, RelatedQuery>();
      for (const list of gsc.queries.values()) {
        for (const q of list) {
          if (!containsPhrase(q.query, phrase, lang)) continue;
          const cur = agg.get(q.query) ?? { query: q.query, clicks: 0, impressions: 0 };
          cur.clicks += q.clicks;
          cur.impressions += q.impressions;
          agg.set(q.query, cur);
        }
      }
      relatedQueries = [...agg.values()].sort((a, b) => b.impressions - a.impressions).slice(0, 200);
      relatedScope = "keyword";
    } else {
      relatedQueries = [];
      relatedScope = null;
    }
  }

  return {
    benchmark,
    relatedQueries,
    relatedScope,
    linkTargets: crawl ? linkTargets(crawl, gsc) : [],
    siteHosts,
    sources: { gsc: gsc !== null, crawl: crawl !== null, competitors: competitorPages },
  };
}

function linkTargets(crawl: SiteCrawl, gsc: Awaited<ReturnType<typeof gscPages>>): LinkTarget[] {
  return crawl.pages
    .filter((p) => p.statusCode === 200 && p.indexable)
    .sort((a, b) => (gsc?.clicks.get(b.normalizedUrl)?.clicks ?? 0) - (gsc?.clicks.get(a.normalizedUrl)?.clicks ?? 0) || b.internalLinksIn - a.internalLinksIn)
    .slice(0, MAX_LINK_TARGETS)
    .map((p) => {
      const phrases: LinkTarget["phrases"] = [];
      for (const q of gsc?.queries.get(p.normalizedUrl)?.slice(0, 3) ?? []) phrases.push({ text: q.query, source: "gsc" });
      const h1 = h1Of(p);
      if (h1) phrases.push({ text: h1, source: "h1" });
      const title = titleWithoutBrand(p.title);
      if (title && title !== h1) phrases.push({ text: title, source: "title" });
      return { url: p.url, title: p.title, phrases, clicks: gsc ? (gsc.clicks.get(p.normalizedUrl)?.clicks ?? 0) : null };
    });
}
