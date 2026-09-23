/**
 * Rank tracking.
 *
 * Two independent measurements per tracked keyword and day, stored side by side
 * (keyword_positions.source):
 *
 *   gsc         Search Console's own numbers for the exact query, filtered by
 *               the keyword's country (and device when set): clicks,
 *               impressions, CTR and *average* position that day, plus the page
 *               with most impressions over the synced window. Free, but only for
 *               queries the site already appears for, and 2–3 days late.
 *   dataforseo  A live Google SERP (top 100) fetched through DataForSEO: the true
 *               organic rank, the ranking URL and the SERP features on the page.
 *               Paid; only when the organization configured it.
 *
 * Search Console is queried in batches: one request per (country, device) group
 * and ~3,000 characters of `^(q1|q2|…)$` RE2 regex, instead of one request per
 * keyword. Each sync re-reads the trailing window (default 7 days) and upserts,
 * so days that were still provisional last time are corrected.
 */
import { and, asc, db, eq, gte, inArray, keywordPositions, keywords, lte, projects, sql, type Keyword } from "@seo/db";
import { NotFound, childLogger, registrableHost } from "@seo/core";
import { gscCountry } from "./countries.js";
import { withDeps, type Deps } from "./deps.js";
import { ProviderError } from "./http.js";
import { clearIntegrationError, loadDataForSeo, markIntegrationFailed, recordUsage } from "./integrations.js";
import { activeKeywords, round1 } from "./keywords.js";
import type { SearchAnalyticsRequest } from "./providers/gsc.js";
import { daysAgo, isoDate, phraseKey, re2Escape } from "./text.js";

/** Headroom under the length Search Console accepts for one filter expression. */
const MAX_REGEX_CHARS = 3000;
const SERP_CONCURRENCY = 3;
/** Reasons after which further paid calls in this sync are pointless. */
const STOP_REASONS = new Set(["invalid_credentials", "insufficient_funds", "access_denied", "rate_limited"]);

export type RankSyncResult = {
  gsc: { configured: boolean; keywords: number; rows: number; from: string; to: string };
  dataforseo: {
    configured: boolean;
    /** Off in the integration settings. */
    disabled: boolean;
    checked: number;
    failed: number;
    cost: number;
    stoppedReason: string | null;
  };
};

/** Group keywords the way Search Console can filter them in one request. */
function groups(list: Keyword[]): Map<string, Keyword[]> {
  const out = new Map<string, Keyword[]>();
  for (const k of list) {
    const key = `${k.country}|${k.device ?? ""}`;
    out.set(key, [...(out.get(key) ?? []), k]);
  }
  return out;
}

/** Split phrases into `^(a|b|…)$` expressions that stay under the length limit. */
export function regexBatches(phrases: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let length = 4;
  for (const p of phrases) {
    const escaped = re2Escape(p);
    if (current.length && length + escaped.length + 1 > MAX_REGEX_CHARS) {
      out.push(`^(${current.join("|")})$`);
      current = [];
      length = 4;
    }
    current.push(escaped);
    length += escaped.length + 1;
  }
  if (current.length) out.push(`^(${current.join("|")})$`);
  return out;
}

async function syncGsc(projectId: string, list: Keyword[], deps: Deps, days: number): Promise<RankSyncResult["gsc"]> {
  const end = daysAgo(1, deps.now());
  const start = daysAgo(days, deps.now());
  const result = { configured: true, keywords: 0, rows: 0, from: isoDate(start), to: isoDate(end) };
  for (const [, group] of groups(list)) {
    const sample = group[0]!;
    const country = gscCountry(sample.country);
    if (!country) continue;
    const byKey = new Map(group.map((k) => [phraseKey(k.phrase), k]));
    for (const expression of regexBatches([...byKey.keys()])) {
      const filters: NonNullable<SearchAnalyticsRequest["filters"]> = [
        { dimension: "query", operator: "includingRegex", expression },
        { dimension: "country", operator: "equals", expression: country },
      ];
      if (sample.device) filters.push({ dimension: "device", operator: "equals", expression: sample.device.toUpperCase() });

      const daily = await deps.gsc.query(projectId, { start, end, dimensions: ["date", "query"], filters, limit: 25_000 });
      if (daily === null) return { ...result, configured: false };
      const pages = await deps.gsc.query(projectId, { start, end, dimensions: ["query", "page"], filters, limit: 25_000 });

      const topPage = new Map<string, { page: string; impressions: number }>();
      for (const r of pages ?? []) {
        const [query, page] = r.keys;
        if (!query || !page) continue;
        const best = topPage.get(query);
        if (!best || r.impressions > best.impressions) topPage.set(query, { page, impressions: r.impressions });
      }

      const values = [];
      const seen = new Set<string>();
      for (const r of daily) {
        const [date, query] = r.keys;
        const kw = query ? byKey.get(phraseKey(query)) : undefined;
        if (!date || !kw) continue;
        seen.add(kw.id);
        values.push({
          keywordId: kw.id,
          date,
          source: "gsc" as const,
          position: round1(r.position),
          url: topPage.get(query!)?.page ?? null,
          clicks: Math.round(r.clicks),
          impressions: Math.round(r.impressions),
          ctr: r.ctr,
        });
      }
      for (let i = 0; i < values.length; i += 1000) {
        await db
          .insert(keywordPositions)
          .values(values.slice(i, i + 1000))
          .onConflictDoUpdate({
            target: [keywordPositions.keywordId, keywordPositions.date, keywordPositions.source],
            set: {
              position: sql`excluded.position`,
              url: sql`excluded.url`,
              clicks: sql`excluded.clicks`,
              impressions: sql`excluded.impressions`,
              ctr: sql`excluded.ctr`,
            },
          });
      }
      result.rows += values.length;
      result.keywords += seen.size;
    }
  }
  return result;
}

function sameSite(domain: string | null, host: string): boolean {
  if (!domain) return false;
  try {
    return registrableHost(domain.toLowerCase()) === registrableHost(host);
  } catch {
    return false;
  }
}

async function syncSerp(
  orgId: string,
  project: { id: string; baseUrl: string },
  list: Keyword[],
  deps: Deps,
): Promise<RankSyncResult["dataforseo"]> {
  const out = { configured: false, disabled: false, checked: 0, failed: 0, cost: 0, stoppedReason: null as string | null };
  const loaded = await loadDataForSeo(orgId, deps);
  if (!loaded) return out;
  out.configured = true;
  if (!loaded.settings.rankTracking) return { ...out, disabled: true };

  const today = isoDate(deps.now());
  // A second sync on the same day does not pay again for keywords already checked.
  const done = new Set(
    (
      await db
        .select({ id: keywordPositions.keywordId })
        .from(keywordPositions)
        .where(
          and(
            inArray(keywordPositions.keywordId, list.map((k) => k.id)),
            eq(keywordPositions.date, today),
            eq(keywordPositions.source, "dataforseo"),
          ),
        )
    ).map((r) => r.id),
  );
  const queue = list.filter((k) => !done.has(k.id)).slice(0, loaded.settings.maxDailySerpChecks);
  const host = new URL(project.baseUrl).hostname;
  const log = childLogger({ component: "rank-serp", projectId: project.id });

  const workers = Array.from({ length: SERP_CONCURRENCY }, async () => {
    for (;;) {
      if (out.stoppedReason) return;
      const kw = queue.shift();
      if (!kw) return;
      try {
        const { value, cost } = await loaded.client.serp({
          keyword: kw.phrase,
          market: { country: kw.country, language: kw.locale },
          device: kw.device ?? "desktop",
          depth: 100,
        });
        out.cost += cost ?? 0;
        await recordUsage({ orgId, projectId: project.id, provider: "dataforseo", endpoint: "serp/google/organic/live/advanced", cost });
        const ours = value.items.find((i) => i.type === "organic" && sameSite(i.domain, host));
        await db
          .insert(keywordPositions)
          .values({
            keywordId: kw.id,
            date: today,
            source: "dataforseo",
            position: ours?.rankGroup ?? null,
            url: ours?.url ?? null,
            serpFeatures: value.features,
          })
          .onConflictDoUpdate({
            target: [keywordPositions.keywordId, keywordPositions.date, keywordPositions.source],
            set: { position: sql`excluded.position`, url: sql`excluded.url`, serpFeatures: sql`excluded.serp_features` },
          });
        out.checked++;
      } catch (err) {
        out.failed++;
        const reason = err instanceof ProviderError ? err.reason : "network_error";
        log.warn({ keywordId: kw.id, reason }, "SERP check failed");
        if (STOP_REASONS.has(reason)) {
          out.stoppedReason = reason;
          await markIntegrationFailed(orgId, "DATAFORSEO", reason);
        }
      }
    }
  });
  await Promise.all(workers);
  if (out.checked > 0 && !out.stoppedReason) await clearIntegrationError(orgId, "DATAFORSEO");
  out.cost = Number(out.cost.toFixed(4));
  return out;
}

export async function syncRank(
  projectId: string,
  partial: Partial<Deps> = {},
  opts: { days?: number } = {},
): Promise<RankSyncResult> {
  const deps = withDeps(partial);
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) throw new NotFound("Project not found");
  const list = await activeKeywords(projectId);
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const empty: RankSyncResult = {
    gsc: { configured: true, keywords: 0, rows: 0, from: isoDate(daysAgo(days, deps.now())), to: isoDate(daysAgo(1, deps.now())) },
    dataforseo: { configured: false, disabled: false, checked: 0, failed: 0, cost: 0, stoppedReason: null },
  };
  if (list.length === 0) return empty;
  const gsc = await syncGsc(projectId, list, deps, days);
  const dataforseo = await syncSerp(project.orgId, project, list, deps);
  return { gsc, dataforseo };
}

// ---------------------------------------------------------------- reading

export type PositionPoint = {
  date: string;
  source: "gsc" | "dataforseo";
  position: number | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  url: string | null;
  serpFeatures: string[] | null;
};

export async function history(
  projectId: string,
  opts: { from: string; to: string; keywordIds?: string[]; source?: "gsc" | "dataforseo" },
): Promise<Array<{ keywordId: string; phrase: string; series: PositionPoint[] }>> {
  const conditions = [
    eq(keywords.projectId, projectId),
    gte(keywordPositions.date, opts.from),
    lte(keywordPositions.date, opts.to),
  ];
  if (opts.keywordIds?.length) conditions.push(inArray(keywords.id, opts.keywordIds));
  if (opts.source) conditions.push(eq(keywordPositions.source, opts.source));
  const rows = await db
    .select({
      keywordId: keywords.id,
      phrase: keywords.phrase,
      date: keywordPositions.date,
      source: keywordPositions.source,
      position: keywordPositions.position,
      clicks: keywordPositions.clicks,
      impressions: keywordPositions.impressions,
      ctr: keywordPositions.ctr,
      url: keywordPositions.url,
      serpFeatures: keywordPositions.serpFeatures,
    })
    .from(keywordPositions)
    .innerJoin(keywords, eq(keywords.id, keywordPositions.keywordId))
    .where(and(...conditions))
    .orderBy(asc(keywords.id), asc(keywordPositions.date));
  const out = new Map<string, { keywordId: string; phrase: string; series: PositionPoint[] }>();
  for (const r of rows) {
    const entry = out.get(r.keywordId) ?? { keywordId: r.keywordId, phrase: r.phrase, series: [] };
    entry.series.push({
      date: r.date,
      source: r.source,
      position: r.position,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      url: r.url,
      serpFeatures: r.serpFeatures,
    });
    out.set(r.keywordId, entry);
  }
  return [...out.values()];
}

export type Mover = {
  keywordId: string;
  phrase: string;
  position: number | null;
  previousPosition: number | null;
  /** previous − current: positive is an improvement. null when the keyword appeared or vanished. */
  change: number | null;
  impressions: number;
};

/**
 * Biggest gains and losses between two equal windows ending at the latest day
 * with data (Search Console lags, so "today" would compare empty days).
 * Positions are impression-weighted for gsc and plain averages for dataforseo.
 * A keyword that dropped out of the current window counts as a loss.
 */
export async function movers(
  projectId: string,
  opts: { days?: number; source?: "gsc" | "dataforseo"; limit?: number } = {},
): Promise<{
  source: "gsc" | "dataforseo";
  current: { from: string; to: string } | null;
  previous: { from: string; to: string } | null;
  gains: Mover[];
  losses: Mover[];
}> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const source = opts.source ?? "gsc";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const lastRes = await db.execute<{ last: string | null }>(sql`
    SELECT max(p.date)::text AS last FROM keyword_positions p JOIN keywords k ON k.id = p.keyword_id
    WHERE k.project_id = ${projectId} AND p.source = ${source} AND k.archived_at IS NULL
  `);
  const last = (lastRes.rows[0] as { last: string | null } | undefined)?.last;
  if (!last) return { source, current: null, previous: null, gains: [], losses: [] };
  const end = new Date(`${last}T00:00:00Z`);
  const curFrom = isoDate(daysAgo(days - 1, end));
  const prevTo = isoDate(daysAgo(days, end));
  const prevFrom = isoDate(daysAgo(2 * days - 1, end));
  const weight = source === "gsc" ? sql`coalesce(p.impressions, 0)` : sql`1`;
  const res = await db.execute(sql`
    SELECT k.id AS "keywordId", k.phrase,
      sum(p.position * ${weight}) FILTER (WHERE p.date >= ${curFrom}::date) / nullif(sum(${weight}) FILTER (WHERE p.date >= ${curFrom}::date AND p.position IS NOT NULL), 0) AS cur,
      sum(p.position * ${weight}) FILTER (WHERE p.date <= ${prevTo}::date) / nullif(sum(${weight}) FILTER (WHERE p.date <= ${prevTo}::date AND p.position IS NOT NULL), 0) AS prev,
      coalesce(sum(p.impressions) FILTER (WHERE p.date >= ${curFrom}::date), 0)::int AS impressions
    FROM keywords k JOIN keyword_positions p ON p.keyword_id = k.id
    WHERE k.project_id = ${projectId} AND k.archived_at IS NULL AND p.source = ${source}
      AND p.date BETWEEN ${prevFrom}::date AND ${last}::date
    GROUP BY k.id, k.phrase
  `);
  const all: Mover[] = (res.rows as Array<{ keywordId: string; phrase: string; cur: number | null; prev: number | null; impressions: number }>)
    .map((r) => {
      const cur = r.cur === null ? null : round1(Number(r.cur));
      const prev = r.prev === null ? null : round1(Number(r.prev));
      return {
        keywordId: r.keywordId,
        phrase: r.phrase,
        position: cur,
        previousPosition: prev,
        change: cur !== null && prev !== null ? round1(prev - cur) : null,
        impressions: Number(r.impressions),
      };
    })
    .filter((m) => m.position !== null || m.previousPosition !== null);
  const gains = all
    .filter((m) => m.change !== null && m.change > 0)
    .sort((a, b) => b.change! - a.change!)
    .slice(0, limit);
  const losses = all
    .filter((m) => (m.change !== null && m.change < 0) || (m.position === null && m.previousPosition !== null))
    // A keyword that vanished is the worst loss there is.
    .sort((a, b) => (a.change ?? -Infinity) - (b.change ?? -Infinity))
    .slice(0, limit);
  return { source, current: { from: curFrom, to: last }, previous: { from: prevFrom, to: prevTo }, gains, losses };
}

// ---------------------------------------------------------------- visibility

/**
 * Expected organic CTR by position — a generic desktop+mobile curve of the kind
 * published in industry CTR studies. It is a model, used only to weight
 * positions for the visibility index; real CTRs are shown from Search Console.
 */
const CTR_BY_POSITION = [0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.03, 0.025];

export function expectedCtr(position: number | null): number {
  if (position === null || !Number.isFinite(position) || position < 1) return 0;
  const p = Math.round(position);
  if (p <= 10) return CTR_BY_POSITION[p - 1]!;
  if (p <= 20) return 0.01;
  return 0;
}

export const VISIBILITY_FORMULA =
  "visibility(d) = 100 × Σk w_k × CTR(pos_k,d) ÷ (Σk w_k × CTR(1)), where w_k = keyword k's average daily Search Console impressions over the range, pos_k,d its average position on day d (a day without data counts as CTR 0), and CTR(p) an industry CTR-by-position curve (28% at #1 … 2.5% at #10, 1% for 11–20, 0 beyond). 100 = every tracked keyword at #1.";

/**
 * A share-of-voice style index from Search Console alone: how much of the
 * clicks available to the tracked keywords the site's positions would capture,
 * each keyword weighted by its own demand (impressions). Weights are fixed over
 * the range, so a keyword that disappears lowers the index instead of leaving
 * the average.
 */
export async function visibility(
  projectId: string,
  opts: { from: string; to: string },
): Promise<{
  formula: string;
  source: "gsc";
  series: Array<{ date: string; visibility: number; clicks: number; impressions: number; keywords: number }>;
}> {
  const rows = await db
    .select({
      keywordId: keywordPositions.keywordId,
      date: keywordPositions.date,
      position: keywordPositions.position,
      clicks: keywordPositions.clicks,
      impressions: keywordPositions.impressions,
    })
    .from(keywordPositions)
    .innerJoin(keywords, eq(keywords.id, keywordPositions.keywordId))
    .where(
      and(
        eq(keywords.projectId, projectId),
        sql`${keywords.archivedAt} IS NULL`,
        eq(keywordPositions.source, "gsc"),
        gte(keywordPositions.date, opts.from),
        lte(keywordPositions.date, opts.to),
      ),
    );
  const weight = new Map<string, { sum: number; days: number }>();
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) {
    const w = weight.get(r.keywordId) ?? { sum: 0, days: 0 };
    w.sum += r.impressions ?? 0;
    w.days += 1;
    weight.set(r.keywordId, w);
    byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  }
  const w = (id: string) => {
    const e = weight.get(id);
    return e && e.days ? e.sum / e.days : 0;
  };
  const denominator = [...weight.keys()].reduce((s, id) => s + w(id), 0) * CTR_BY_POSITION[0]!;
  const series = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const numerator = list.reduce((s, r) => s + w(r.keywordId) * expectedCtr(r.position), 0);
      return {
        date,
        visibility: denominator > 0 ? round1((100 * numerator) / denominator) : 0,
        clicks: list.reduce((s, r) => s + (r.clicks ?? 0), 0),
        impressions: list.reduce((s, r) => s + (r.impressions ?? 0), 0),
        keywords: list.length,
      };
    });
  return { formula: VISIBILITY_FORMULA, source: "gsc", series };
}
