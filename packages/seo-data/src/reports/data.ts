/**
 * The facts a report prints, read from the database and Search Console at
 * generation time. Only real data: a section whose source is not connected (or
 * has nothing yet) carries `null` and the template says so instead of drawing
 * an empty chart or a zero that looks like a measurement.
 */
import {
  and,
  approvals,
  auditRuns,
  db,
  desc,
  eq,
  fixExecutions,
  fixProposals,
  gte,
  organizations,
  pageSnapshots,
  seoIssues,
  sql,
  type ReportBrand,
  type ReportKind,
  type Severity,
} from "@seo/db";
import type { ScoreBreakdown } from "@seo/core";
import { withDeps, type Deps } from "../deps.js";
import { daysAgo, isoDate } from "../text.js";
import { projectById } from "../site.js";
import { listKeywords } from "../keywords.js";
import { movers, visibility } from "../rank.js";
import { summary as pageSpeedSummary, type PageSpeedSummary } from "../pagespeed.js";

export type AuditFacts = {
  run: { id: string; finishedAt: Date | null; score: number | null; pagesCrawled: number; breakdown: ScoreBreakdown | null } | null;
  previousScore: number | null;
  history: Array<{ date: string; score: number }>;
  severity: Record<Severity, number>;
  topIssues: Array<{ title: string; severity: Severity; category: string; pages: number; ruleId: string }>;
  pages: { total: number; ok: number; redirects: number; errors: number; indexable: number; avgResponseMs: number | null } | null;
  fixes: { appliedLast30Days: number; awaitingApproval: number };
};

export type GscFacts = {
  current: { from: string; to: string; clicks: number; impressions: number; ctr: number | null; position: number | null };
  previous: { from: string; to: string; clicks: number; impressions: number; ctr: number | null; position: number | null };
  daily: Array<{ date: string; clicks: number; impressions: number }>;
  topQueries: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  topPages: Array<{ page: string; clicks: number; impressions: number; position: number }>;
};

export type KeywordFacts = {
  tracked: number;
  rows: Array<{ phrase: string; position: number | null; previousPosition: number | null; clicks: number; impressions: number; url: string | null; lastDate: string | null }>;
  movers: Awaited<ReturnType<typeof movers>>;
  visibility: Array<{ date: string; visibility: number }>;
};

export type ReportFacts = {
  kind: ReportKind;
  generatedAt: Date;
  project: { id: string; name: string; baseUrl: string };
  orgName: string;
  brand: ReportBrand;
  audit: AuditFacts;
  gsc: GscFacts | null;
  pagespeed: Pick<PageSpeedSummary, "totals" | "lastRunAt"> | null;
  keywords: KeywordFacts | null;
};

const SEVERITIES: Severity[] = ["CRITICAL", "SERIOUS", "WARNING", "INFO"];

async function auditFacts(projectId: string, now: Date): Promise<AuditFacts> {
  const runs = await db
    .select({ id: auditRuns.id, finishedAt: auditRuns.finishedAt, score: auditRuns.score, pagesCrawled: auditRuns.pagesCrawled, breakdown: auditRuns.scoreBreakdown })
    .from(auditRuns)
    .where(and(eq(auditRuns.projectId, projectId), eq(auditRuns.status, "SUCCEEDED")))
    .orderBy(desc(auditRuns.finishedAt))
    .limit(12);
  const latest = runs[0];
  const counts = await db
    .select({ severity: seoIssues.severity, n: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(and(eq(seoIssues.projectId, projectId), eq(seoIssues.status, "OPEN")))
    .groupBy(seoIssues.severity);
  const severity = Object.fromEntries(SEVERITIES.map((s) => [s, counts.find((c) => c.severity === s)?.n ?? 0])) as Record<Severity, number>;
  const issues = await db
    .select({ title: seoIssues.title, severity: seoIssues.severity, category: seoIssues.category, pages: seoIssues.pageCount, ruleId: seoIssues.ruleId })
    .from(seoIssues)
    .where(and(eq(seoIssues.projectId, projectId), eq(seoIssues.status, "OPEN")))
    .orderBy(sql`array_position(ARRAY['CRITICAL','SERIOUS','WARNING','INFO']::severity[], ${seoIssues.severity})`, desc(seoIssues.pageCount))
    .limit(30);
  let pages: AuditFacts["pages"] = null;
  if (latest) {
    const row = (
      await db
        .select({
          total: sql<number>`count(*)::int`,
          ok: sql<number>`count(*) FILTER (WHERE ${pageSnapshots.statusCode} = 200)::int`,
          redirects: sql<number>`count(*) FILTER (WHERE ${pageSnapshots.statusCode} BETWEEN 300 AND 399)::int`,
          errors: sql<number>`count(*) FILTER (WHERE ${pageSnapshots.statusCode} >= 400 OR ${pageSnapshots.statusCode} = 0)::int`,
          indexable: sql<number>`count(*) FILTER (WHERE ${pageSnapshots.indexable})::int`,
          avg: sql<number | null>`avg(${pageSnapshots.responseMs}) FILTER (WHERE ${pageSnapshots.statusCode} = 200)`,
        })
        .from(pageSnapshots)
        .where(eq(pageSnapshots.auditRunId, latest.id))
    )[0]!;
    pages = { total: row.total, ok: row.ok, redirects: row.redirects, errors: row.errors, indexable: row.indexable, avgResponseMs: row.avg === null ? null : Math.round(Number(row.avg)) };
  }
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const applied = (
    await db
      .select({ n: sql<number>`coalesce(sum(${fixExecutions.appliedCount}), 0)::int` })
      .from(fixExecutions)
      .innerJoin(fixProposals, eq(fixProposals.id, fixExecutions.fixProposalId))
      .where(and(eq(fixProposals.projectId, projectId), eq(fixExecutions.dryRun, false), gte(fixExecutions.startedAt, since), sql`${fixExecutions.rolledBackAt} IS NULL`))
  )[0]!.n;
  const awaiting = (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(fixProposals)
      .innerJoin(approvals, eq(approvals.fixProposalId, fixProposals.id))
      .where(and(eq(fixProposals.projectId, projectId), eq(fixProposals.status, "AWAITING_APPROVAL")))
  )[0]!.n;
  return {
    run: latest
      ? { id: latest.id, finishedAt: latest.finishedAt, score: latest.score, pagesCrawled: latest.pagesCrawled, breakdown: (latest.breakdown as ScoreBreakdown | null) ?? null }
      : null,
    previousScore: runs[1]?.score ?? null,
    history: runs
      .filter((r) => r.score !== null && r.finishedAt)
      .map((r) => ({ date: r.finishedAt!.toISOString().slice(0, 10), score: r.score! }))
      .reverse(),
    severity,
    topIssues: issues,
    pages,
    fixes: { appliedLast30Days: applied, awaitingApproval: awaiting },
  };
}

function totals(rows: Array<{ clicks: number; impressions: number; position: number }>) {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const posWeighted = rows.reduce((s, r) => s + r.position * r.impressions, 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: impressions ? Math.round((posWeighted / impressions) * 10) / 10 : null };
}

/** The last 28 days to yesterday against the 28 before, from Search Console; null without it. */
async function gscFacts(projectId: string, deps: Deps): Promise<GscFacts | null> {
  const end = daysAgo(1, deps.now());
  const start = daysAgo(28, deps.now());
  const prevEnd = daysAgo(29, deps.now());
  const prevStart = daysAgo(56, deps.now());
  const daily = await deps.gsc.query(projectId, { start: prevStart, end, dimensions: ["date"], limit: 100 }).catch(() => null);
  if (daily === null) return null;
  const inRange = (d: string, a: Date, b: Date) => d >= isoDate(a) && d <= isoDate(b);
  const rows = daily.map((r) => ({ date: r.keys[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: r.position }));
  const cur = rows.filter((r) => inRange(r.date, start, end));
  const prev = rows.filter((r) => inRange(r.date, prevStart, prevEnd));
  const [queries, pages] = await Promise.all([
    deps.gsc.query(projectId, { start, end, dimensions: ["query"], limit: 1000 }).catch(() => []),
    deps.gsc.query(projectId, { start, end, dimensions: ["page"], limit: 1000 }).catch(() => []),
  ]);
  const top = <T>(list: Array<{ keys: string[]; clicks: number; impressions: number; position: number }> | null, mk: (k: string) => T) =>
    (list ?? [])
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, 10)
      .map((r) => ({ ...mk(r.keys[0] ?? ""), clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 }));
  return {
    current: { from: isoDate(start), to: isoDate(end), ...totals(cur) },
    previous: { from: isoDate(prevStart), to: isoDate(prevEnd), ...totals(prev) },
    daily: cur.sort((a, b) => a.date.localeCompare(b.date)).map(({ date, clicks, impressions }) => ({ date, clicks, impressions })),
    topQueries: top(queries, (query) => ({ query })),
    topPages: top(pages, (page) => ({ page })),
  };
}

async function keywordFacts(projectId: string, deps: Deps): Promise<KeywordFacts | null> {
  const list = await listKeywords(projectId);
  if (!list.keywords.length) return null;
  const to = isoDate(daysAgo(1, deps.now()));
  const from = isoDate(daysAgo(90, deps.now()));
  const [m, v] = await Promise.all([movers(projectId, { days: 28, limit: 10 }), visibility(projectId, { from, to })]);
  return {
    tracked: list.keywords.length,
    rows: list.keywords
      .map((k) => ({
        phrase: k.phrase,
        position: k.gsc?.position ?? null,
        previousPosition: k.gsc?.previousPosition ?? null,
        clicks: k.gsc?.clicks ?? 0,
        impressions: k.gsc?.impressions ?? 0,
        url: k.gsc?.url ?? null,
        lastDate: k.gsc?.lastDate ?? null,
      }))
      .sort((a, b) => b.impressions - a.impressions || (a.position ?? 999) - (b.position ?? 999))
      .slice(0, 100),
    movers: m,
    visibility: v.series.map((s) => ({ date: s.date, visibility: s.visibility })),
  };
}

export async function collectFacts(projectId: string, kind: ReportKind, brand: ReportBrand, partial: Partial<Deps> = {}): Promise<ReportFacts> {
  const deps = withDeps(partial);
  const project = await projectById(projectId);
  const org = (await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, project.orgId)).limit(1))[0];
  const audit = await auditFacts(projectId, deps.now());
  const wantsGsc = kind !== "audit";
  const [gsc, psi, kw] = await Promise.all([
    wantsGsc ? gscFacts(projectId, deps) : Promise.resolve(null),
    kind === "executive" ? pageSpeedSummary(projectId).catch(() => null) : Promise.resolve(null),
    kind !== "audit" ? keywordFacts(projectId, deps) : Promise.resolve(null),
  ]);
  return {
    kind,
    generatedAt: deps.now(),
    project: { id: project.id, name: project.name, baseUrl: project.baseUrl },
    orgName: org?.name ?? "",
    brand,
    audit,
    gsc,
    pagespeed: psi && psi.pages.length ? { totals: psi.totals, lastRunAt: psi.lastRunAt } : null,
    keywords: kw,
  };
}
