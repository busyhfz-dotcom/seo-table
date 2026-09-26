/**
 * PageSpeed / Core Web Vitals for a project's important pages.
 *
 * Which pages: the homepage, then the pages with most Search Console clicks
 * over 28 days (what visitors actually land on), or — without Search Console —
 * the latest scan's best-linked indexable pages. Capped by PAGESPEED_MAX_URLS;
 * each page costs two PSI calls (mobile and desktop).
 *
 * PSI quota: calls are serialised through one Redis-paced slot per second
 * across all workers (the pagespeed queue also runs one job at a time), and the
 * client backs off on 429.
 */
import { and, auditRuns, db, desc, eq, gte, lte, pageSnapshots, pageSpeed, projects, sql, type PageSpeedRow, type PageSpeedStrategy } from "@seo/db";
import { NotFound, childLogger, env, hostGate, normalizeUrl } from "@seo/core";
import { withDeps, type Deps } from "./deps.js";
import { ProviderError } from "./http.js";
import { loadPageSpeed, pageSpeedKeySource } from "./integrations.js";
import { assessCwv, type CwvAssessment, type PageSpeedMeasurement } from "./providers/pagespeed.js";
import { daysAgo } from "./text.js";

const STRATEGIES: PageSpeedStrategy[] = ["mobile", "desktop"];

function onSite(baseUrl: string, url: string): boolean {
  try {
    const a = new URL(baseUrl).hostname.replace(/^www\./, "");
    const b = new URL(url).hostname.replace(/^www\./, "");
    return a === b;
  } catch {
    return false;
  }
}

export async function selectUrls(projectId: string, partial: Partial<Deps> = {}, max = env().PAGESPEED_MAX_URLS): Promise<string[]> {
  const deps = withDeps(partial);
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) throw new NotFound("Project not found");
  const out: string[] = [project.baseUrl];
  const seen = new Set([normalizeUrl(project.baseUrl) ?? project.baseUrl]);
  const push = (url: string) => {
    const key = normalizeUrl(url) ?? url;
    if (out.length >= max || seen.has(key) || !onSite(project.baseUrl, url)) return;
    seen.add(key);
    out.push(url);
  };
  const rows = await deps.gsc
    .query(projectId, { start: daysAgo(28, deps.now()), end: daysAgo(1, deps.now()), dimensions: ["page"], limit: 200 })
    .catch(() => null);
  if (rows?.length) {
    for (const r of [...rows].sort((a, b) => b.clicks - a.clicks)) if (r.keys[0]) push(r.keys[0]);
  }
  if (out.length < max) {
    const run = (
      await db
        .select({ id: auditRuns.id })
        .from(auditRuns)
        .where(and(eq(auditRuns.projectId, projectId), eq(auditRuns.status, "SUCCEEDED")))
        .orderBy(desc(auditRuns.finishedAt))
        .limit(1)
    )[0];
    if (run) {
      const pages = await db
        .select({ url: pageSnapshots.url })
        .from(pageSnapshots)
        .where(and(eq(pageSnapshots.auditRunId, run.id), eq(pageSnapshots.statusCode, 200), eq(pageSnapshots.indexable, true)))
        .orderBy(desc(pageSnapshots.internalLinksIn), pageSnapshots.depth)
        .limit(max * 2);
      for (const p of pages) push(p.url);
    }
  }
  return out;
}

export type PageSpeedRunResult = {
  keySource: "org" | "env" | "none";
  measured: PageSpeedRow[];
  failed: Array<{ url: string; strategy: PageSpeedStrategy; reason: string }>;
};

/** One PSI slot per second for the whole deployment. */
export async function psiSlot(): Promise<void> {
  await hostGate("pagespeedonline.googleapis.com", 1);
}

export async function runPageSpeed(
  projectId: string,
  opts: { urls?: string[] } = {},
  partial: Partial<Deps> = {},
): Promise<PageSpeedRunResult> {
  const deps = withDeps(partial);
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) throw new NotFound("Project not found");
  const urls = opts.urls?.length ? opts.urls.filter((u) => onSite(project.baseUrl, u)) : await selectUrls(projectId, deps);
  const { client, keySource } = await loadPageSpeed(project.orgId, deps);
  const log = childLogger({ component: "pagespeed", projectId });
  const result: PageSpeedRunResult = { keySource, measured: [], failed: [] };
  const fetchedAt = deps.now();

  for (const url of urls) {
    for (const strategy of STRATEGIES) {
      await psiSlot();
      let m: PageSpeedMeasurement;
      try {
        m = await client.run(url, strategy);
      } catch (err) {
        const reason = err instanceof ProviderError ? err.reason : "network_error";
        log.warn({ url, strategy, reason }, "PageSpeed run failed");
        result.failed.push({ url, strategy, reason });
        // Out of quota or a bad key: the remaining calls would fail the same way.
        if (reason === "quota_exceeded" || reason === "invalid_credentials") return result;
        continue;
      }
      const row = (
        await db
          .insert(pageSpeed)
          .values({
            projectId,
            url,
            strategy,
            fetchedAt,
            performanceScore: m.performanceScore,
            lcpMs: m.lcpMs,
            cls: m.cls,
            inpMs: m.inpMs,
            ttfbMs: m.ttfbMs,
            fcpMs: m.fcpMs,
            tbtMs: m.tbtMs,
            fieldData: m.fieldData,
            opportunities: m.opportunities,
          })
          .returning()
      )[0]!;
      result.measured.push(row);
    }
  }
  return result;
}

export type PageSpeedSummaryItem = {
  url: string;
  strategy: PageSpeedStrategy;
  fetchedAt: string;
  performanceScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  tbtMs: number | null;
  fieldData: PageSpeedRow["fieldData"];
  opportunities: PageSpeedRow["opportunities"];
  cwv: CwvAssessment;
  /** Change in performance score since the previous measurement of the same page and strategy. */
  scoreChange: number | null;
};

export type PageSpeedSummary = {
  source: "pagespeed_insights";
  keySource: "org" | "env" | "none";
  lastRunAt: string | null;
  pages: PageSpeedSummaryItem[];
  totals: Record<PageSpeedStrategy, { pages: number; passed: number; failed: number; averageScore: number | null }>;
};

export async function summary(projectId: string): Promise<PageSpeedSummary> {
  const project = (await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) throw new NotFound("Project not found");
  // The two newest rows per page and strategy: the current one and what it changed from.
  const res = await db.execute(sql`
    SELECT * FROM (
      SELECT ps.*, row_number() OVER (PARTITION BY url, strategy ORDER BY fetched_at DESC) AS rn
      FROM page_speed ps WHERE project_id = ${projectId}
    ) x WHERE rn <= 2 ORDER BY url, strategy, rn
  `);
  type Raw = {
    url: string;
    strategy: PageSpeedStrategy;
    fetched_at: Date;
    performance_score: number | null;
    lcp_ms: number | null;
    cls: number | null;
    inp_ms: number | null;
    ttfb_ms: number | null;
    fcp_ms: number | null;
    tbt_ms: number | null;
    field_data: PageSpeedRow["fieldData"];
    opportunities: PageSpeedRow["opportunities"];
    rn: string | number;
  };
  const rows = res.rows as Raw[];
  const pages: PageSpeedSummaryItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (Number(r.rn) !== 1) continue;
    const prev = rows[i + 1] && Number(rows[i + 1]!.rn) === 2 ? rows[i + 1]! : null;
    pages.push({
      url: r.url,
      strategy: r.strategy,
      fetchedAt: new Date(r.fetched_at).toISOString(),
      performanceScore: r.performance_score,
      lcpMs: r.lcp_ms,
      cls: r.cls,
      inpMs: r.inp_ms,
      ttfbMs: r.ttfb_ms,
      fcpMs: r.fcp_ms,
      tbtMs: r.tbt_ms,
      fieldData: r.field_data,
      opportunities: r.opportunities,
      cwv: assessCwv({ lcpMs: r.lcp_ms, cls: r.cls, fieldData: r.field_data }),
      scoreChange:
        prev && prev.performance_score !== null && r.performance_score !== null ? r.performance_score - prev.performance_score : null,
    });
  }
  const totals = Object.fromEntries(
    STRATEGIES.map((s) => {
      const list = pages.filter((p) => p.strategy === s);
      const scored = list.filter((p) => p.performanceScore !== null);
      return [
        s,
        {
          pages: list.length,
          passed: list.filter((p) => p.cwv.passed).length,
          failed: list.filter((p) => !p.cwv.passed).length,
          averageScore: scored.length ? Math.round(scored.reduce((a, p) => a + p.performanceScore!, 0) / scored.length) : null,
        },
      ];
    }),
  ) as PageSpeedSummary["totals"];
  const last = pages.reduce<string | null>((m, p) => (m === null || p.fetchedAt > m ? p.fetchedAt : m), null);
  return { source: "pagespeed_insights", keySource: await pageSpeedKeySource(project.orgId), lastRunAt: last, pages, totals };
}

export async function history(
  projectId: string,
  opts: { url?: string; strategy?: PageSpeedStrategy; from: Date; to: Date },
): Promise<Array<Omit<PageSpeedRow, "opportunities"> & { cwv: CwvAssessment }>> {
  const conditions = [eq(pageSpeed.projectId, projectId), gte(pageSpeed.fetchedAt, opts.from), lte(pageSpeed.fetchedAt, opts.to)];
  if (opts.url) conditions.push(eq(pageSpeed.url, opts.url));
  if (opts.strategy) conditions.push(eq(pageSpeed.strategy, opts.strategy));
  const rows = await db
    .select()
    .from(pageSpeed)
    .where(and(...conditions))
    .orderBy(pageSpeed.url, pageSpeed.strategy, pageSpeed.fetchedAt)
    .limit(5000);
  return rows.map(({ opportunities: _o, ...r }) => ({ ...r, cwv: assessCwv(r) }));
}

/** Whether a URL may be measured for this project (the API refuses other sites' pages). */
export async function urlsBelongToProject(projectId: string, urls: string[]): Promise<boolean> {
  const project = (await db.select({ baseUrl: projects.baseUrl }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project) return false;
  return urls.every((u) => onSite(project.baseUrl, u));
}
