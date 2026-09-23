/**
 * A content brief for a keyword, from real sources only:
 *   - Search Console: the site's queries containing the keyword (with clicks,
 *     impressions and average position), the questions among them, and our
 *     pages already ranking for them;
 *   - competitors: the pages our crawler sampled whose title/H1/H2s mention the
 *     keyword — their length and H2 outlines. Similar H2s across competitors
 *     are grouped (shared meaningful words, Jaccard ≥ 0.5) and ranked by how
 *     many different competitor sites use them;
 *   - targets: the median length of those pages, and the title/description
 *     lengths search results show in full.
 * Every list says where it came from; a source that is not connected is empty
 * and flagged, never filled in.
 */
import { and, competitorSnapshots, competitors, db, eq, sql } from "@seo/db";
import { withDeps, type Deps } from "../deps.js";
import { h1Of, key, latestCrawl } from "../site.js";
import { cachedGsc } from "./context.js";
import { median } from "./analyze.js";
import { SERP } from "./serp-width.js";
import { containsPhrase, topicTerms, type Lang } from "./text.js";

export type ContentBrief = {
  keyword: string;
  lang: Lang;
  sources: { gsc: boolean; competitorPages: number; crawl: boolean };
  period: { from: string; to: string } | null;
  queries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  questions: string[];
  ourPages: Array<{ url: string; title: string | null; clicks: number; impressions: number; bestPosition: number; words: number | null }>;
  competitorPages: Array<{ url: string; domain: string; title: string | null; words: number; h2: string[] }>;
  outline: Array<{ heading: string; sites: number; source: "competitors" | "gsc_question" }>;
  targets: {
    words: number | null;
    wordsSource: "our_pages_and_competitors" | "competitors" | "our_pages" | null;
    titleChars: [number, number];
    descriptionChars: [number, number];
  };
};

// \b is ASCII-only in JavaScript, so Persian words end at whitespace or the end.
const QUESTION_FA = /^(چطور|چگونه|چرا|چه|چی|چیست|کدام|کجا|کی|آیا|چند|چقدر)(?:\s|$)|(چیست|چیه|چطوره|کجاست|چند است)\s*[؟?]?$/u;
const QUESTION_EN = /^(how|what|why|which|where|when|who|can|does|do|is|are|should)\b/i;

export async function contentBrief(
  projectId: string,
  input: { keyword: string; locale: string },
  partial: Partial<Deps> = {},
): Promise<ContentBrief> {
  const deps = withDeps(partial);
  const lang: Lang = input.locale.startsWith("fa") ? "fa" : "en";
  const phrase = input.keyword.trim();
  const [gsc, crawl] = await Promise.all([cachedGsc(projectId, deps), latestCrawl(projectId)]);

  // ---- Search Console
  const byQuery = new Map<string, { query: string; clicks: number; impressions: number; posSum: number }>();
  const pages = new Map<string, { clicks: number; impressions: number; bestPosition: number }>();
  if (gsc) {
    for (const [url, list] of gsc.queries) {
      for (const q of list) {
        if (!containsPhrase(q.query, phrase, lang)) continue;
        const cur = byQuery.get(q.query) ?? { query: q.query, clicks: 0, impressions: 0, posSum: 0 };
        cur.clicks += q.clicks;
        cur.impressions += q.impressions;
        cur.posSum += q.position * q.impressions;
        byQuery.set(q.query, cur);
        const p = pages.get(url) ?? { clicks: 0, impressions: 0, bestPosition: Infinity };
        p.clicks += q.clicks;
        p.impressions += q.impressions;
        p.bestPosition = Math.min(p.bestPosition, q.position);
        pages.set(url, p);
      }
    }
  }
  const queries = [...byQuery.values()]
    .map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, position: q.impressions ? Math.round((q.posSum / q.impressions) * 10) / 10 : 0 }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 50);
  const questions = queries.map((q) => q.query).filter((q) => (lang === "fa" ? QUESTION_FA : QUESTION_EN).test(q.trim())).slice(0, 15);
  const ourPages = [...pages.entries()]
    .map(([url, p]) => {
      const page = crawl?.byUrl.get(key(url));
      return { url, title: page?.title ?? null, clicks: p.clicks, impressions: p.impressions, bestPosition: Math.round(p.bestPosition * 10) / 10, words: page?.wordCount ?? null };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, 10);

  // ---- competitors
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
  const competitorPages = rows
    .filter((r) => r.statusCode === 200 && containsPhrase([r.title ?? "", ...(r.h1 ?? []), ...(r.headings?.h2 ?? [])].join(" \n "), phrase, lang))
    .map((r) => ({ url: r.url, domain: r.domain, title: r.title, words: r.wordCount, h2: r.headings?.h2 ?? [] }))
    .sort((a, b) => b.words - a.words);

  // ---- outline: similar H2s grouped across competitor sites
  const groups: Array<{ heading: string; terms: Set<string>; domains: Set<string> }> = [];
  for (const page of competitorPages) {
    for (const h2 of page.h2) {
      const terms = topicTerms(h2, lang);
      if (terms.size === 0) continue;
      const group = groups.find((g) => jaccard(g.terms, terms) >= 0.5);
      if (group) group.domains.add(page.domain);
      else groups.push({ heading: h2, terms, domains: new Set([page.domain]) });
    }
  }
  const outline: ContentBrief["outline"] = groups
    .sort((a, b) => b.domains.size - a.domains.size)
    .slice(0, 12)
    .map((g) => ({ heading: g.heading, sites: g.domains.size, source: "competitors" as const }));
  for (const q of questions.slice(0, 5)) outline.push({ heading: q, sites: 0, source: "gsc_question" });

  // ---- targets
  const ourWords = ourPages.map((p) => p.words ?? 0).filter((w) => w > 0);
  const theirWords = competitorPages.map((p) => p.words);
  const words = median([...ourWords, ...theirWords]);
  const wordsSource = !words ? null : ourWords.length && theirWords.length ? "our_pages_and_competitors" : theirWords.length ? "competitors" : "our_pages";

  return {
    keyword: phrase,
    lang,
    sources: { gsc: gsc !== null, competitorPages: competitorPages.length, crawl: crawl !== null },
    period: gsc ? { from: gsc.from, to: gsc.to } : null,
    queries,
    questions,
    ourPages: ourPages.map((p) => ({ ...p, title: p.title ?? (crawl ? h1OfUrl(crawl, p.url) : null) })),
    competitorPages: competitorPages.slice(0, 20),
    outline,
    targets: {
      words,
      wordsSource,
      titleChars: [SERP.title.minChars, SERP.title.maxChars],
      descriptionChars: [SERP.description.minChars, SERP.description.maxChars],
    },
  };
}

function h1OfUrl(crawl: NonNullable<Awaited<ReturnType<typeof latestCrawl>>>, url: string): string | null {
  const page = crawl.byUrl.get(key(url));
  return page ? h1Of(page) : null;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}
