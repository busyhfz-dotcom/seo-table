/**
 * Keyword discovery, mapping and cannibalization.
 *
 * Sources, each labelled in every response:
 *   gsc           queries the site already gets impressions for (real numbers);
 *   autocomplete  Google's suggestions for a seed — no volume data, ever;
 *   dataforseo    ideas with volume/difficulty/CPC, when the org configured it.
 *
 * Results are cached in keyword_ideas (autocomplete 7 days, dataforseo 30 days,
 * gsc 1 day), so reopening a screen neither spends money nor hammers Google.
 */
import { and, db, desc, eq, gte, keywordIdeas, sql, type IdeaSource, type Keyword } from "@seo/db";
import { withDeps, type Deps } from "./deps.js";
import { ProviderError } from "./http.js";
import { clearIntegrationError, loadDataForSeo, markIntegrationFailed, recordUsage } from "./integrations.js";
import { activeKeywords, round1 } from "./keywords.js";
import { daysAgo, isoDate, normalizePhrase, phraseKey } from "./text.js";

const TTL_MS: Record<IdeaSource, number> = {
  autocomplete: 7 * 86_400_000,
  dataforseo: 30 * 86_400_000,
  gsc: 86_400_000,
};

type Market = { locale: string; country: string };

async function cached(projectId: string, source: IdeaSource, seed: string, market: Market, now: Date) {
  return db
    .select()
    .from(keywordIdeas)
    .where(
      and(
        eq(keywordIdeas.projectId, projectId),
        eq(keywordIdeas.source, source),
        eq(keywordIdeas.seed, seed),
        eq(keywordIdeas.locale, market.locale),
        eq(keywordIdeas.country, market.country),
        gte(keywordIdeas.createdAt, new Date(now.getTime() - TTL_MS[source])),
      ),
    )
    .orderBy(desc(keywordIdeas.volume), keywordIdeas.idea);
}

/** Replace a seed's cached ideas atomically, so a refresh never leaves a half-old list. */
async function store(
  projectId: string,
  source: IdeaSource,
  seed: string,
  market: Market,
  rows: Array<Partial<typeof keywordIdeas.$inferInsert> & { idea: string }>,
  now: Date,
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(keywordIdeas)
      .where(
        and(
          eq(keywordIdeas.projectId, projectId),
          eq(keywordIdeas.source, source),
          eq(keywordIdeas.seed, seed),
          eq(keywordIdeas.locale, market.locale),
          eq(keywordIdeas.country, market.country),
        ),
      );
    if (rows.length) {
      await tx
        .insert(keywordIdeas)
        .values(rows.map((r) => ({ ...r, projectId, source, seed, locale: market.locale, country: market.country, createdAt: now })))
        .onConflictDoNothing();
    }
  });
}

async function trackedKeys(projectId: string): Promise<Set<string>> {
  return new Set((await activeKeywords(projectId)).map((k) => phraseKey(k.phrase)));
}

// ---------------------------------------------------------------- Search Console opportunities

export type GscOpportunity = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** Extra monthly clicks if the query reached position 3, by the CTR model. */
  potentialClicks: number;
};

/**
 * Queries the site already shows for at positions 4–20 with real impressions,
 * that are not tracked yet — the cheapest rankings to improve.
 */
export async function gscOpportunities(
  projectId: string,
  partial: Partial<Deps> = {},
  opts: { days?: number; minImpressions?: number; limit?: number } = {},
): Promise<{ configured: false } | { configured: true; source: "gsc"; from: string; to: string; items: GscOpportunity[] }> {
  const deps = withDeps(partial);
  const days = Math.min(Math.max(opts.days ?? 28, 7), 90);
  const minImpressions = opts.minImpressions ?? 20;
  const end = daysAgo(1, deps.now());
  const start = daysAgo(days, deps.now());
  const rows = await deps.gsc.query(projectId, { start, end, dimensions: ["query"], limit: 25_000 });
  if (rows === null) return { configured: false };
  const tracked = await trackedKeys(projectId);
  const monthly = 30 / days;
  const items = rows
    .filter((r) => r.keys[0] && r.position >= 4 && r.position <= 20 && r.impressions >= minImpressions)
    .filter((r) => !tracked.has(phraseKey(r.keys[0]!)))
    .map((r) => ({
      query: r.keys[0]!,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: round1(r.position),
      potentialClicks: Math.max(0, Math.round((r.impressions * 0.11 - r.clicks) * monthly)),
    }))
    .sort((a, b) => b.potentialClicks - a.potentialClicks || b.impressions - a.impressions)
    .slice(0, Math.min(opts.limit ?? 200, 1000));
  // Cached as ideas under the empty seed and an all-markets key ("*"/"ZZ"):
  // these rows are site-wide, not tied to one language or country.
  await store(
    projectId,
    "gsc",
    "",
    { locale: "*", country: "ZZ" },
    items.map((i) => ({ idea: i.query, impressions: Math.round(i.impressions), clicks: Math.round(i.clicks), position: i.position })),
    deps.now(),
  );
  return { configured: true, source: "gsc", from: isoDate(start), to: isoDate(end), items };
}

// ---------------------------------------------------------------- autocomplete

export async function suggestions(
  projectId: string,
  seedRaw: string,
  market: Market,
  partial: Partial<Deps> = {},
): Promise<{ source: "autocomplete"; volumeData: false; seed: string; cached: boolean; items: Array<{ idea: string; tracked: boolean }> }> {
  const deps = withDeps(partial);
  const seed = normalizePhrase(seedRaw);
  const tracked = await trackedKeys(projectId);
  const hit = await cached(projectId, "autocomplete", seed, market, deps.now());
  let ideas: string[];
  let fromCache = false;
  if (hit.length) {
    ideas = hit.map((h) => h.idea);
    fromCache = true;
  } else {
    ideas = (await deps.suggest.suggest(seed, { language: market.locale, country: market.country })).map(normalizePhrase);
    ideas = [...new Set(ideas)].filter((i) => i && phraseKey(i) !== phraseKey(seed));
    await store(projectId, "autocomplete", seed, market, ideas.map((idea) => ({ idea })), deps.now());
  }
  return {
    source: "autocomplete",
    volumeData: false,
    seed,
    cached: fromCache,
    items: ideas.map((idea) => ({ idea, tracked: tracked.has(phraseKey(idea)) })),
  };
}

// ---------------------------------------------------------------- DataForSEO ideas

export type IdeaItem = {
  idea: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  tracked: boolean;
};

export async function researchIdeas(
  orgId: string,
  projectId: string,
  input: { seeds: string[]; locale: string; country: string; limit?: number },
  partial: Partial<Deps> = {},
): Promise<
  | { configured: false }
  | { configured: true; source: "dataforseo"; cached: boolean; cost: number | null; currency: "USD"; items: IdeaItem[] }
> {
  const deps = withDeps(partial);
  const loaded = await loadDataForSeo(orgId, deps);
  if (!loaded) return { configured: false };
  const seeds = [...new Set(input.seeds.map(normalizePhrase).filter(Boolean))].slice(0, 20);
  // One cache entry per seed set, keyed by the sorted seeds.
  const seedKey = seeds.map((s) => s.toLowerCase()).sort().join(" | ");
  const market = { locale: input.locale, country: input.country };
  const tracked = await trackedKeys(projectId);
  const hit = await cached(projectId, "dataforseo", seedKey, market, deps.now());
  if (hit.length) {
    return {
      configured: true,
      source: "dataforseo",
      cached: true,
      cost: 0,
      currency: "USD",
      items: hit.map((h) => ({ idea: h.idea, volume: h.volume, difficulty: h.difficulty, cpc: h.cpc, tracked: tracked.has(phraseKey(h.idea)) })),
    };
  }
  let result;
  try {
    result = await loaded.client.keywordIdeas(seeds, { country: input.country, language: input.locale }, input.limit ?? 200);
  } catch (err) {
    if (err instanceof ProviderError) await markIntegrationFailed(orgId, "DATAFORSEO", err.reason);
    throw err;
  }
  await recordUsage({ orgId, projectId, provider: "dataforseo", endpoint: "dataforseo_labs/google/keyword_ideas/live", cost: result.cost });
  await clearIntegrationError(orgId, "DATAFORSEO");
  const unique = new Map(result.value.map((k) => [phraseKey(k.keyword), k]));
  const rows = [...unique.values()].map((k) => ({
    idea: normalizePhrase(k.keyword),
    volume: k.volume,
    difficulty: k.difficulty === null ? null : Math.round(k.difficulty),
    cpc: k.cpc,
  }));
  await store(projectId, "dataforseo", seedKey, market, rows, deps.now());
  return {
    configured: true,
    source: "dataforseo",
    cached: false,
    cost: result.cost,
    currency: "USD",
    items: rows
      .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1))
      .map((r) => ({ ...r, tracked: tracked.has(phraseKey(r.idea)) })),
  };
}

// ---------------------------------------------------------------- keyword → page mapping

export type MappingItem = {
  keywordId: string;
  phrase: string;
  targetUrl: string | null;
  /** The page Google actually shows, from the newest data of either source. */
  rankingUrl: string | null;
  rankingSource: "gsc" | "dataforseo" | null;
  /** null when there is no target or no ranking page to compare. */
  matches: boolean | null;
};

function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
    return x.hostname.replace(/^www\./, "") === y.hostname.replace(/^www\./, "") && path(x) === path(y);
  } catch {
    return a === b;
  }
}

export async function mapping(projectId: string): Promise<MappingItem[]> {
  const list = await activeKeywords(projectId);
  if (!list.length) return [];
  const latest = await db.execute(sql`
    SELECT DISTINCT ON (p.keyword_id) p.keyword_id AS "keywordId", p.url, p.source
    FROM keyword_positions p JOIN keywords k ON k.id = p.keyword_id
    WHERE k.project_id = ${projectId} AND p.url IS NOT NULL
    ORDER BY p.keyword_id, p.date DESC, (p.source = 'dataforseo') DESC
  `);
  const byId = new Map((latest.rows as Array<{ keywordId: string; url: string; source: "gsc" | "dataforseo" }>).map((r) => [r.keywordId, r]));
  return list.map((k: Keyword) => {
    const r = byId.get(k.id);
    return {
      keywordId: k.id,
      phrase: k.phrase,
      targetUrl: k.targetUrl,
      rankingUrl: r?.url ?? null,
      rankingSource: r?.source ?? null,
      matches: k.targetUrl && r?.url ? samePage(k.targetUrl, r.url) : null,
    };
  });
}

// ---------------------------------------------------------------- cannibalization

export type CannibalizationItem = {
  query: string;
  tracked: boolean;
  impressions: number;
  clicks: number;
  pages: Array<{ url: string; impressions: number; clicks: number; position: number; share: number }>;
};

/**
 * Queries for which Search Console shows two or more of the site's pages, each
 * with a real share (≥ 10% of the query's impressions and ≥ 5 impressions):
 * pages splitting one query's demand, usually to the detriment of both.
 */
export async function cannibalization(
  projectId: string,
  partial: Partial<Deps> = {},
  opts: { days?: number; minShare?: number; limit?: number } = {},
): Promise<{ configured: false } | { configured: true; source: "gsc"; from: string; to: string; items: CannibalizationItem[] }> {
  const deps = withDeps(partial);
  const days = Math.min(Math.max(opts.days ?? 28, 7), 90);
  const minShare = opts.minShare ?? 0.1;
  const end = daysAgo(1, deps.now());
  const start = daysAgo(days, deps.now());
  const rows = await deps.gsc.query(projectId, { start, end, dimensions: ["query", "page"], limit: 25_000 });
  if (rows === null) return { configured: false };
  const tracked = await trackedKeys(projectId);
  const byQuery = new Map<string, Array<{ url: string; impressions: number; clicks: number; position: number }>>();
  for (const r of rows) {
    const [query, url] = r.keys;
    if (!query || !url) continue;
    byQuery.set(query, [...(byQuery.get(query) ?? []), { url, impressions: r.impressions, clicks: r.clicks, position: r.position }]);
  }
  const items: CannibalizationItem[] = [];
  for (const [query, pages] of byQuery) {
    if (pages.length < 2) continue;
    const impressions = pages.reduce((s, p) => s + p.impressions, 0);
    if (impressions <= 0) continue;
    const significant = pages
      .map((p) => ({ ...p, position: round1(p.position), share: Math.round((p.impressions / impressions) * 1000) / 1000 }))
      .filter((p) => p.share >= minShare && p.impressions >= 5)
      .sort((a, b) => b.impressions - a.impressions);
    if (significant.length < 2) continue;
    items.push({
      query,
      tracked: tracked.has(phraseKey(query)),
      impressions,
      clicks: pages.reduce((s, p) => s + p.clicks, 0),
      pages: significant,
    });
  }
  items.sort((a, b) => Number(b.tracked) - Number(a.tracked) || b.impressions - a.impressions);
  return { configured: true, source: "gsc", from: isoDate(start), to: isoDate(end), items: items.slice(0, opts.limit ?? 200) };
}
