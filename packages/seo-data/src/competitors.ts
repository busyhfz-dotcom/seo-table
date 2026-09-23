/**
 * Competitors: a bounded, polite sample of each rival's pages (homepage plus
 * sitemap pages, at most 30), compared with the same sample of our own site
 * taken by the same code — so differences are the sites', not the method's.
 *
 * Keyword gap and backlinks need DataForSEO; without it they answer
 * {configured: false}.
 */
import { z } from "zod";
import { and, competitorSnapshots, competitors, db, desc, eq, inArray, isUniqueViolation, projects, sql, type Competitor, type CompetitorSnapshot } from "@seo/db";
import { BadRequest, Conflict, NotFound, assertPublicUrl, childLogger } from "@seo/core";
import { withDeps, type Deps } from "./deps.js";
import { ProviderError } from "./http.js";
import { clearIntegrationError, loadDataForSeo, loadPageSpeed, markIntegrationFailed, recordUsage } from "./integrations.js";
import { psiSlot } from "./pagespeed.js";
import type { BacklinkSummary } from "./providers/types.js";
import { samplePages } from "./sampler.js";
import { toDomain } from "./text.js";

export const MAX_COMPETITORS = 10;
export const SAMPLE_CAP = 30;
/** Batches of snapshots kept per competitor; older ones are deleted. */
const KEEP_BATCHES = 5;
/** Our own site is re-sampled at most this often, however many competitors are analysed. */
const SELF_MAX_AGE_MS = 20 * 3_600_000;

export const competitorInput = z.object({
  domain: z.string().trim().min(3).max(253),
  name: z.string().trim().min(1).max(120).nullable().optional(),
});

async function projectOf(projectId: string) {
  const p = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!p) throw new NotFound("Project not found");
  return p;
}

const bare = (host: string) => host.replace(/^www\./, "");

export async function addCompetitor(projectId: string, input: z.infer<typeof competitorInput>): Promise<Competitor> {
  const project = await projectOf(projectId);
  const domain = toDomain(input.domain);
  if (!domain) throw new BadRequest("Enter a domain such as rival.example", { field: "domain" });
  if (bare(domain) === bare(new URL(project.baseUrl).hostname)) {
    throw new BadRequest("That is this project's own site", { field: "domain" });
  }
  // Refused now with a clear 400; every fetch is checked again, since DNS can change.
  await assertPublicUrl(`https://${domain}/`);
  const [{ n }] = (await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM competitors WHERE project_id = ${projectId} AND NOT is_self
  `)).rows as [{ n: number }];
  if (n >= MAX_COMPETITORS) throw new BadRequest(`A project can have at most ${MAX_COMPETITORS} competitors`);
  try {
    return (await db.insert(competitors).values({ projectId, domain, name: input.name ?? null }).returning())[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new Conflict("That competitor is already added", { domain });
    throw err;
  }
}

export async function updateCompetitor(projectId: string, id: string, input: { name?: string | null }): Promise<Competitor> {
  const updated = await db
    .update(competitors)
    .set({ name: input.name ?? null })
    .where(and(eq(competitors.id, id), eq(competitors.projectId, projectId), eq(competitors.isSelf, false)))
    .returning();
  if (!updated[0]) throw new NotFound("Competitor not found");
  return updated[0];
}

export async function deleteCompetitor(projectId: string, id: string): Promise<void> {
  const gone = await db
    .delete(competitors)
    .where(and(eq(competitors.id, id), eq(competitors.projectId, projectId), eq(competitors.isSelf, false)))
    .returning({ id: competitors.id });
  if (!gone[0]) throw new NotFound("Competitor not found");
}

export async function getCompetitor(projectId: string, id: string): Promise<Competitor> {
  const c = (
    await db
      .select()
      .from(competitors)
      .where(and(eq(competitors.id, id), eq(competitors.projectId, projectId), eq(competitors.isSelf, false)))
      .limit(1)
  )[0];
  if (!c) throw new NotFound("Competitor not found");
  return c;
}

/** The newest batch of snapshots for each competitor (a batch shares one fetchedAt). */
async function latestBatches(competitorIds: string[]): Promise<Map<string, CompetitorSnapshot[]>> {
  const out = new Map<string, CompetitorSnapshot[]>();
  if (!competitorIds.length) return out;
  const rows = await db
    .select()
    .from(competitorSnapshots)
    .where(
      and(
        inArray(competitorSnapshots.competitorId, competitorIds),
        sql`${competitorSnapshots.fetchedAt} = (SELECT max(s2.fetched_at) FROM competitor_snapshots s2 WHERE s2.competitor_id = ${competitorSnapshots.competitorId})`,
      ),
    )
    .orderBy(competitorSnapshots.url);
  for (const r of rows) out.set(r.competitorId, [...(out.get(r.competitorId) ?? []), r]);
  return out;
}

export type CompetitorListItem = Competitor & {
  lastAnalyzedAt: string | null;
  pagesSampled: number;
};

export async function listCompetitors(projectId: string): Promise<CompetitorListItem[]> {
  const list = await db
    .select()
    .from(competitors)
    .where(and(eq(competitors.projectId, projectId), eq(competitors.isSelf, false)))
    .orderBy(competitors.createdAt);
  const batches = await latestBatches(list.map((c) => c.id));
  return list.map((c) => {
    const b = batches.get(c.id) ?? [];
    return { ...c, lastAnalyzedAt: b[0]?.fetchedAt.toISOString() ?? null, pagesSampled: b.length };
  });
}

export async function competitorPages(projectId: string, id: string): Promise<{ competitor: Competitor; pages: CompetitorSnapshot[] }> {
  const competitor = await getCompetitor(projectId, id);
  return { competitor, pages: (await latestBatches([id])).get(id) ?? [] };
}

// ---------------------------------------------------------------- snapshot job

async function selfRow(projectId: string, baseUrl: string): Promise<Competitor> {
  const domain = new URL(baseUrl).hostname.toLowerCase();
  await db.insert(competitors).values({ projectId, domain, isSelf: true, name: null }).onConflictDoNothing();
  const row = (await db.select().from(competitors).where(and(eq(competitors.projectId, projectId), eq(competitors.isSelf, true))).limit(1))[0];
  if (!row) throw new Conflict("The project's own site is registered as a competitor");
  return row;
}

export type SnapshotResult = Array<{
  competitorId: string;
  domain: string;
  self: boolean;
  pages: number;
  robots: "ok" | "missing" | "unreachable";
  error: string | null;
}>;

async function snapshotOne(
  orgId: string,
  competitor: Competitor,
  baseUrl: string,
  deps: Deps,
  signal?: AbortSignal,
): Promise<SnapshotResult[number]> {
  const log = childLogger({ component: "competitors", competitorId: competitor.id });
  const fetchedAt = deps.now();
  let sample;
  try {
    sample = await samplePages(baseUrl, { cap: SAMPLE_CAP, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    log.warn({ err: (err as Error).message }, "sampling failed");
    return { competitorId: competitor.id, domain: competitor.domain, self: competitor.isSelf, pages: 0, robots: "unreachable", error: (err as Error).message };
  }
  // Homepage lab CWV from PageSpeed (mobile), best effort: a PSI failure must not lose the sample.
  let lcpMs: number | null = null;
  let cls: number | null = null;
  const home = sample.pages[0];
  if (home?.statusCode === 200) {
    try {
      const { client } = await loadPageSpeed(orgId, deps);
      await psiSlot();
      const m = await client.run(home.url, "mobile");
      lcpMs = m.lcpMs;
      cls = m.cls;
    } catch (err) {
      log.info({ reason: err instanceof ProviderError ? err.reason : "network_error" }, "homepage PageSpeed skipped");
    }
  }
  if (sample.pages.length) {
    await db.insert(competitorSnapshots).values(
      sample.pages.map((p, i) => ({
        competitorId: competitor.id,
        url: p.url,
        fetchedAt,
        statusCode: p.statusCode,
        title: p.title,
        metaDescription: p.metaDescription,
        h1: p.h1,
        headings: p.headings,
        wordCount: p.wordCount,
        schemaTypes: p.schemaTypes,
        internalLinks: p.internalLinks,
        externalLinks: p.externalLinks,
        lcpMs: i === 0 ? lcpMs : null,
        cls: i === 0 ? cls : null,
      })),
    );
    await db.execute(sql`
      DELETE FROM competitor_snapshots WHERE competitor_id = ${competitor.id} AND fetched_at < (
        SELECT min(f) FROM (SELECT DISTINCT fetched_at AS f FROM competitor_snapshots WHERE competitor_id = ${competitor.id}
                            ORDER BY f DESC LIMIT ${KEEP_BATCHES}) keep
      )
    `);
  }
  return { competitorId: competitor.id, domain: competitor.domain, self: competitor.isSelf, pages: sample.pages.length, robots: sample.robots, error: null };
}

export async function snapshotCompetitors(
  projectId: string,
  opts: { competitorId?: string; signal?: AbortSignal } = {},
  partial: Partial<Deps> = {},
): Promise<SnapshotResult> {
  const deps = withDeps(partial);
  const project = await projectOf(projectId);
  const targets = opts.competitorId
    ? [await getCompetitor(projectId, opts.competitorId)]
    : await db.select().from(competitors).where(and(eq(competitors.projectId, projectId), eq(competitors.isSelf, false)));
  if (!targets.length) return [];
  const results: SnapshotResult = [];
  const self = await selfRow(projectId, project.baseUrl);
  const selfLatest = (
    await db.select({ at: competitorSnapshots.fetchedAt }).from(competitorSnapshots).where(eq(competitorSnapshots.competitorId, self.id)).orderBy(desc(competitorSnapshots.fetchedAt)).limit(1)
  )[0]?.at;
  if (!selfLatest || deps.now().getTime() - selfLatest.getTime() > SELF_MAX_AGE_MS) {
    results.push(await snapshotOne(project.orgId, self, project.baseUrl, deps, opts.signal));
  }
  for (const c of targets) results.push(await snapshotOne(project.orgId, c, deps.competitorUrl(c.domain), deps, opts.signal));
  return results;
}

// ---------------------------------------------------------------- comparison

export type SiteStats = {
  analyzedAt: string;
  pagesSampled: number;
  okPages: number;
  avgTitleLength: number | null;
  avgMetaDescriptionLength: number | null;
  pagesMissingTitle: number;
  pagesMissingMetaDescription: number;
  pagesWithOneH1: number;
  avgWordCount: number | null;
  medianWordCount: number | null;
  avgH2: number | null;
  avgInternalLinks: number | null;
  avgExternalLinks: number | null;
  /** Schema.org types and how many sampled pages carry each. */
  schemaTypes: Array<{ type: string; pages: number }>;
  homepage: { url: string; title: string | null; metaDescription: string | null; lcpMs: number | null; cls: number | null } | null;
};

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

export function siteStats(pages: CompetitorSnapshot[]): SiteStats | null {
  if (!pages.length) return null;
  const ok = pages.filter((p) => p.statusCode === 200);
  const types = new Map<string, number>();
  for (const p of ok) for (const t of new Set(p.schemaTypes)) types.set(t, (types.get(t) ?? 0) + 1);
  const home = pages.find((p) => p.lcpMs !== null || p.cls !== null) ?? pages[0]!;
  const chars = (s: string | null) => (s ? [...s].length : 0);
  return {
    analyzedAt: pages[0]!.fetchedAt.toISOString(),
    pagesSampled: pages.length,
    okPages: ok.length,
    avgTitleLength: avg(ok.filter((p) => p.title).map((p) => chars(p.title))),
    avgMetaDescriptionLength: avg(ok.filter((p) => p.metaDescription).map((p) => chars(p.metaDescription))),
    pagesMissingTitle: ok.filter((p) => !p.title).length,
    pagesMissingMetaDescription: ok.filter((p) => !p.metaDescription).length,
    pagesWithOneH1: ok.filter((p) => p.h1.length === 1).length,
    avgWordCount: avg(ok.map((p) => p.wordCount)),
    medianWordCount: median(ok.map((p) => p.wordCount)),
    avgH2: avg(ok.map((p) => p.headings?.counts.h2 ?? 0)),
    avgInternalLinks: avg(ok.map((p) => p.internalLinks)),
    avgExternalLinks: avg(ok.map((p) => p.externalLinks)),
    schemaTypes: [...types.entries()].map(([type, n]) => ({ type, pages: n })).sort((a, b) => b.pages - a.pages),
    homepage: { url: home.url, title: home.title, metaDescription: home.metaDescription, lcpMs: home.lcpMs, cls: home.cls },
  };
}

export async function compare(projectId: string): Promise<{
  ours: SiteStats | null;
  competitors: Array<{ id: string; domain: string; name: string | null; stats: SiteStats | null }>;
}> {
  const all = await db.select().from(competitors).where(eq(competitors.projectId, projectId)).orderBy(competitors.createdAt);
  const batches = await latestBatches(all.map((c) => c.id));
  const self = all.find((c) => c.isSelf);
  return {
    ours: self ? siteStats(batches.get(self.id) ?? []) : null,
    competitors: all
      .filter((c) => !c.isSelf)
      .map((c) => ({ id: c.id, domain: c.domain, name: c.name, stats: siteStats(batches.get(c.id) ?? []) })),
  };
}

// ---------------------------------------------------------------- paid: keyword gap, backlinks

export type GapKeyword = { keyword: string; theirPosition: number; ourPosition: number | null; volume: number | null; difficulty: number | null; url: string | null };

/**
 * Keywords the competitor ranks for in the top 20 where we do not rank, or rank
 * worse — from DataForSEO Labs' ranked-keywords data for both domains.
 */
export async function keywordGap(
  orgId: string,
  projectId: string,
  competitorId: string,
  market: { country: string; locale: string },
  partial: Partial<Deps> = {},
): Promise<
  | { configured: false }
  | { configured: true; source: "dataforseo"; cost: number; currency: "USD"; missing: GapKeyword[]; behind: GapKeyword[]; shared: number }
> {
  const deps = withDeps(partial);
  const loaded = await loadDataForSeo(orgId, deps);
  if (!loaded) return { configured: false };
  const project = await projectOf(projectId);
  const competitor = await getCompetitor(projectId, competitorId);
  const m = { country: market.country, language: market.locale };
  let theirs, ours;
  try {
    theirs = await loaded.client.rankedKeywords(bare(competitor.domain), m, 1000);
    await recordUsage({ orgId, projectId, provider: "dataforseo", endpoint: "dataforseo_labs/google/ranked_keywords/live", cost: theirs.cost });
    ours = await loaded.client.rankedKeywords(bare(new URL(project.baseUrl).hostname), m, 1000);
    await recordUsage({ orgId, projectId, provider: "dataforseo", endpoint: "dataforseo_labs/google/ranked_keywords/live", cost: ours.cost });
  } catch (err) {
    if (err instanceof ProviderError) await markIntegrationFailed(orgId, "DATAFORSEO", err.reason);
    throw err;
  }
  await clearIntegrationError(orgId, "DATAFORSEO");
  const ourPos = new Map(ours.value.map((k) => [k.keyword.toLowerCase(), k.position]));
  const missing: GapKeyword[] = [];
  const behind: GapKeyword[] = [];
  let shared = 0;
  for (const k of theirs.value) {
    if (k.position > 20) continue;
    const mine = ourPos.get(k.keyword.toLowerCase()) ?? null;
    const item = { keyword: k.keyword, theirPosition: k.position, ourPosition: mine, volume: k.volume, difficulty: k.difficulty, url: k.url };
    if (mine === null) missing.push(item);
    else {
      shared++;
      if (mine > k.position) behind.push(item);
    }
  }
  const byVolume = (a: GapKeyword, b: GapKeyword) => (b.volume ?? -1) - (a.volume ?? -1);
  return {
    configured: true,
    source: "dataforseo",
    cost: Number(((theirs.cost ?? 0) + (ours.cost ?? 0)).toFixed(4)),
    currency: "USD",
    missing: missing.sort(byVolume).slice(0, 500),
    behind: behind.sort(byVolume).slice(0, 500),
    shared,
  };
}

export async function backlinkComparison(
  orgId: string,
  projectId: string,
  competitorId: string,
  partial: Partial<Deps> = {},
): Promise<
  | { configured: false }
  | {
      configured: true;
      source: "dataforseo";
      cost: number;
      currency: "USD";
      ours: BacklinkSummary;
      theirs: BacklinkSummary;
    }
> {
  const deps = withDeps(partial);
  const loaded = await loadDataForSeo(orgId, deps);
  if (!loaded) return { configured: false };
  const project = await projectOf(projectId);
  const competitor = await getCompetitor(projectId, competitorId);
  try {
    const ours = await loaded.client.backlinkSummary(bare(new URL(project.baseUrl).hostname));
    await recordUsage({ orgId, projectId, provider: "dataforseo", endpoint: "backlinks/summary/live", cost: ours.cost });
    const theirs = await loaded.client.backlinkSummary(bare(competitor.domain));
    await recordUsage({ orgId, projectId, provider: "dataforseo", endpoint: "backlinks/summary/live", cost: theirs.cost });
    await clearIntegrationError(orgId, "DATAFORSEO");
    return {
      configured: true,
      source: "dataforseo",
      cost: Number(((ours.cost ?? 0) + (theirs.cost ?? 0)).toFixed(4)),
      currency: "USD",
      ours: ours.value,
      theirs: theirs.value,
    };
  } catch (err) {
    // Backlinks is a separate DataForSEO subscription: access_denied here does
    // not mean the whole integration is broken, so it is not recorded as one.
    if (err instanceof ProviderError && err.reason !== "access_denied") await markIntegrationFailed(orgId, "DATAFORSEO", err.reason);
    throw err;
  }
}
