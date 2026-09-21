/**
 * The analysis stage of a run: crawl → snapshots → rules → issues → score.
 *
 * Retry safety: a retried job re-uses the same run row. Snapshots are upserted on
 * (run, url) and occurrences are inserted with onConflictDoNothing, so a second
 * attempt converges on the same state instead of doubling it.
 */
import {
  and,
  auditRuns,
  db,
  eq,
  pageSnapshots,
  projects,
  seoIssues,
  sql,
  type AuditRun,
  type NewPageSnapshot,
  type Project,
} from "@seo/db";
import {
  childLogger,
  computeScore,
  crawl,
  issueService,
  metric,
  proposalService,
  resolveRedirects,
  runRules,
  type AnalyzedPage,
  type CrawlResult,
  type ScoreBreakdown,
} from "@seo/core";

export type AnalyzeOutcome = {
  runId: string;
  pagesCrawled: number;
  score: number;
  breakdown: ScoreBreakdown;
  issues: Awaited<ReturnType<typeof issueService.persistFindings>>;
  proposals: number;
  canceled: boolean;
};

export async function analyze(runId: string, signal?: AbortSignal): Promise<AnalyzeOutcome> {
  const log = childLogger({ component: "analyze", runId });

  const run = (await db.select().from(auditRuns).where(eq(auditRuns.id, runId)).limit(1))[0];
  if (!run) throw new Error(`Run ${runId} not found`);
  const project = (
    await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1)
  )[0];
  if (!project) throw new Error(`Project ${run.projectId} not found`);

  if (run.status === "CANCELED") {
    log.info("run was cancelled before it started");
    return emptyOutcome(runId, true);
  }

  await db
    .update(auditRuns)
    .set({ status: "RUNNING", startedAt: run.startedAt ?? new Date(), attempts: run.attempts + 1 })
    .where(eq(auditRuns.id, runId));

  // ---- crawl -------------------------------------------------------------
  let lastProgressWrite = 0;
  const crawlResult: CrawlResult = await crawl({
    baseUrl: project.baseUrl,
    pageCap: project.pageCap,
    requestsPerSecond: project.crawlRate,
    ...(signal ? { signal } : {}),
    onProgress: async (done, queued) => {
      // Throttled so progress does not turn into a write per page.
      if (Date.now() - lastProgressWrite < 2000) return;
      lastProgressWrite = Date.now();
      await db
        .update(auditRuns)
        .set({ pagesCrawled: done, pagesTotal: done + queued })
        .where(eq(auditRuns.id, runId));
    },
  });

  if (await wasCanceled(runId)) {
    log.info("run cancelled during crawl");
    return emptyOutcome(runId, true);
  }

  // ---- persist snapshots -------------------------------------------------
  // Chains are resolved from the redirect graph once the whole crawl is in.
  const redirects = resolveRedirects(
    crawlResult.pages.map((p) => ({
      normalizedUrl: p.normalizedUrl,
      statusCode: p.statusCode,
      redirectTarget: p.redirectTarget,
    })),
  );

  const analyzed: AnalyzedPage[] = crawlResult.pages.map((page) => ({
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    depth: page.depth,
    statusCode: page.statusCode,
    responseMs: page.responseMs,
    title: page.extracted?.title ?? null,
    titleLength: page.extracted?.titleLength ?? 0,
    metaDescription: page.extracted?.metaDescription ?? null,
    metaDescriptionLength: page.extracted?.metaDescriptionLength ?? 0,
    h1s: page.extracted?.h1s ?? [],
    canonical: page.extracted?.canonical ?? null,
    robotsMeta: page.extracted?.robotsMeta ?? null,
    xRobotsTag: page.xRobotsTag,
    indexable: page.indexable,
    noindexReason: page.noindexReason,
    lang: page.extracted?.lang ?? null,
    wordCount: page.extracted?.wordCount ?? 0,
    imagesTotal: page.extracted?.imagesTotal ?? 0,
    imagesMissingAlt: page.extracted?.imagesMissingAlt ?? 0,
    imagesWithoutAlt: page.extracted?.imagesWithoutAlt ?? [],
    links: page.extracted?.links ?? [],
    internalLinksOut: page.extracted?.internalLinksOut ?? 0,
    externalLinksOut: page.extracted?.externalLinksOut ?? 0,
    internalLinksIn: crawlResult.inboundLinks.get(page.normalizedUrl) ?? 0,
    inSitemap: page.inSitemap,
    redirectTarget: page.redirectTarget,
    redirectChain: redirects.get(page.normalizedUrl)?.chain ?? [],
    redirectLoop: redirects.get(page.normalizedUrl)?.loop ?? false,
    textHash: page.extracted?.textHash ?? null,
  }));

  const snapshotRows: NewPageSnapshot[] = analyzed.map((p, i) => ({
    auditRunId: runId,
    projectId: project.id,
    url: p.url,
    normalizedUrl: p.normalizedUrl,
    depth: p.depth,
    statusCode: p.statusCode,
    responseMs: p.responseMs,
    contentHash: crawlResult.pages[i]?.extracted?.contentHash ?? "",
    bodyBytes: crawlResult.pages[i]?.bodyBytes ?? 0,
    title: p.title,
    titleLength: p.titleLength,
    metaDescription: p.metaDescription,
    metaDescriptionLength: p.metaDescriptionLength,
    h1s: p.h1s,
    canonical: p.canonical,
    robotsMeta: p.robotsMeta,
    xRobotsTag: p.xRobotsTag,
    indexable: p.indexable,
    noindexReason: p.noindexReason,
    lang: p.lang,
    wordCount: p.wordCount,
    imagesTotal: p.imagesTotal,
    imagesMissingAlt: p.imagesMissingAlt,
    internalLinksOut: p.internalLinksOut,
    internalLinksIn: p.internalLinksIn,
    externalLinksOut: p.externalLinksOut,
    inSitemap: p.inSitemap,
    redirectChain: p.redirectChain,
    redirectTarget: p.redirectTarget,
  }));

  // One row per normalised URL per run: the unique index demands it, and an
  // ON CONFLICT batch containing the same key twice is an error in Postgres.
  const deduped = new Map<string, NewPageSnapshot>();
  for (const row of snapshotRows) {
    if (!deduped.has(row.normalizedUrl)) deduped.set(row.normalizedUrl, row);
  }

  const snapshotIdByUrl = new Map<string, string>();
  for (const chunk of chunks([...deduped.values()], 200)) {
    const written = await db
      .insert(pageSnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [pageSnapshots.auditRunId, pageSnapshots.normalizedUrl],
        set: {
          statusCode: sqlExcluded("status_code"),
          title: sqlExcluded("title"),
          internalLinksIn: sqlExcluded("internal_links_in"),
          indexable: sqlExcluded("indexable"),
          fetchedAt: new Date(),
        },
      })
      .returning({ id: pageSnapshots.id, normalizedUrl: pageSnapshots.normalizedUrl });
    for (const row of written) snapshotIdByUrl.set(row.normalizedUrl, row.id);
  }

  // ---- rules -------------------------------------------------------------
  const { findings, groups, perRule } = runRules({
    project: { id: project.id, baseUrl: project.baseUrl, locale: project.locale },
    pages: analyzed,
    sitemapUrls: crawlResult.sitemapUrls,
    robots: crawlResult.robots,
  });

  const issues = await issueService.persistFindings({
    projectId: project.id,
    runId,
    groups,
    snapshotIdByUrl,
  });

  // ---- proposals ---------------------------------------------------------
  const issueRows = await db
    .select({ id: seoIssues.id, fingerprint: seoIssues.fingerprint })
    .from(seoIssues)
    .where(eq(seoIssues.projectId, project.id));
  const issueIdByFingerprint = new Map(issueRows.map((r) => [r.fingerprint, r.id]));

  const drafts = proposalService.draftsFromGroups(project.id, groups, issueIdByFingerprint);
  const created = await proposalService.createProposals({
    orgId: project.orgId,
    actor: { type: "AGENT", id: "agent" },
    drafts,
  });

  // ---- score -------------------------------------------------------------
  const breakdown = computeScore(analyzed, findings);

  await db
    .update(auditRuns)
    .set({
      status: "SUCCEEDED",
      pagesCrawled: analyzed.length,
      pagesTotal: analyzed.length,
      score: breakdown.score,
      scoreBreakdown: { ...breakdown, perRule, skipped: crawlResult.skipped },
      finishedAt: new Date(),
      error: null,
      errorCode: null,
    })
    .where(eq(auditRuns.id, runId));

  await db.update(projects).set({ score: breakdown.score }).where(eq(projects.id, project.id));

  metric("run.succeeded");
  metric("run.score", breakdown.score);
  log.info(
    { pages: analyzed.length, score: breakdown.score, findings: findings.length, proposals: created.length },
    "analysis complete",
  );

  return {
    runId,
    pagesCrawled: analyzed.length,
    score: breakdown.score,
    breakdown,
    issues,
    proposals: created.length,
    canceled: false,
  };
}

export async function markRunFailed(runId: string, err: unknown, dead: boolean): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(auditRuns)
    .set({
      status: dead ? "DEAD_LETTER" : "FAILED",
      error: message.slice(0, 2000),
      errorCode: dead ? "RETRIES_EXHAUSTED" : "ATTEMPT_FAILED",
      finishedAt: new Date(),
    })
    .where(eq(auditRuns.id, runId));
  metric(dead ? "run.dead_letter" : "run.failed");
}

async function wasCanceled(runId: string): Promise<boolean> {
  const rows = await db
    .select({ status: auditRuns.status })
    .from(auditRuns)
    .where(and(eq(auditRuns.id, runId), eq(auditRuns.status, "CANCELED")))
    .limit(1);
  return rows.length > 0;
}

function emptyOutcome(runId: string, canceled: boolean): AnalyzeOutcome {
  return {
    runId,
    pagesCrawled: 0,
    score: 0,
    breakdown: { score: 0, pagesScored: 0, byCategory: [], bySeverity: [], worstPages: [] },
    issues: {
      issuesOpened: 0,
      issuesPersisted: 0,
      issuesRegressed: 0,
      issuesResolved: 0,
      occurrencesWritten: 0,
    },
    proposals: 0,
    canceled,
  };
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** `excluded.<column>` reference for an upsert's SET clause. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

export type { Project, AuditRun };
