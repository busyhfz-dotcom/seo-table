/**
 * The analysis stage of a run: crawl → snapshots → rules → issues → score.
 *
 * Retry safety: a retried job re-uses the same run row. Snapshots are upserted on
 * (run, url), occurrences are inserted with onConflictDoNothing, and a proposal
 * is not drafted again for a change an open proposal already carries, so a
 * second attempt converges on the same state instead of doubling it.
 *
 * Liveness: the run's heartbeat is refreshed on a timer for as long as the job
 * works, not only when a page completes — a polite crawl with a long
 * Crawl-delay can go minutes between pages and must not look dead to the reaper.
 */
import {
  and,
  auditRuns,
  db,
  eq,
  fixProposals,
  inArray,
  pageDetails,
  pageSnapshots,
  projects,
  seoIssues,
  sql,
  type AuditRun,
  type NewPageSnapshot,
  type Project,
} from "@seo/db";
import {
  BlockedAddressError,
  childLogger,
  computeScore,
  crawl,
  env,
  issueService,
  metric,
  proposalService,
  resolveRedirects,
  runRules,
  scanService,
  type AnalyzedPage,
  type CrawlResult,
  type ScoreBreakdown,
} from "@seo/core";
import { PLATFORM_MAX_AGE_MS, refreshPlatform } from "@seo/connectors";

type ProposalDraft = ReturnType<typeof proposalService.draftsFromGroups>[number];

export type AnalyzeOutcome = {
  runId: string;
  pagesCrawled: number;
  score: number;
  breakdown: ScoreBreakdown;
  issues: Awaited<ReturnType<typeof issueService.persistFindings>>;
  proposals: number;
  canceled: boolean;
  /**
   * The run was not QUEUED or RUNNING when the job picked it up (already
   * finished, failed or reaped), so nothing was done. The worker must not run
   * the agent for it.
   */
  skipped: boolean;
};

/** How often the run's heartbeat is refreshed while the job works. */
const HEARTBEAT_EVERY_MS = 30_000;
/** Rows per multi-row INSERT; well under Postgres' 65535 bind-parameter limit. */
const INSERT_CHUNK = 200;

export async function analyze(runId: string, signal?: AbortSignal): Promise<AnalyzeOutcome> {
  const log = childLogger({ component: "analyze", runId });

  const run = (await db.select().from(auditRuns).where(eq(auditRuns.id, runId)).limit(1))[0];
  if (!run) throw new Error(`Run ${runId} not found`);
  const project = (
    await db.select().from(projects).where(eq(projects.id, run.projectId)).limit(1)
  )[0];
  if (!project) throw new Error(`Project ${run.projectId} not found`);

  // Claimed with a conditional update: a duplicate or late job for a run that
  // is finished, cancelled or reaped must not bring it back to life.
  const started = await db
    .update(auditRuns)
    .set({
      status: "RUNNING",
      startedAt: run.startedAt ?? new Date(),
      heartbeatAt: new Date(),
      attempts: sql`${auditRuns.attempts} + 1`,
    })
    .where(and(eq(auditRuns.id, runId), inArray(auditRuns.status, ["QUEUED", "RUNNING"])))
    .returning({ id: auditRuns.id });
  if (started.length === 0) {
    const status = (await db.select({ status: auditRuns.status }).from(auditRuns).where(eq(auditRuns.id, runId)))[0]?.status;
    log.info({ status }, "run is not active; nothing to do");
    return emptyOutcome(runId, status === "CANCELED", true);
  }

  const beat = () =>
    scanService.heartbeat(runId).catch((err: unknown) => log.warn({ err: (err as Error).message }, "heartbeat failed"));
  const heartbeat = setInterval(beat, HEARTBEAT_EVERY_MS);
  heartbeat.unref();
  try {
    return await analyzeRun(run, project, log, beat, signal);
  } finally {
    clearInterval(heartbeat);
  }
}

async function analyzeRun(
  run: AuditRun,
  project: Project,
  log: ReturnType<typeof childLogger>,
  beat: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<AnalyzeOutcome> {
  const runId = run.id;
  const userAgent = env().CRAWLER_USER_AGENT;

  // ---- crawl -------------------------------------------------------------
  let lastProgressWrite = 0;
  const crawlResult: CrawlResult = await crawl({
    baseUrl: project.baseUrl,
    pageCap: project.pageCap,
    requestsPerSecond: project.crawlRate,
    userAgent,
    ...(signal ? { signal } : {}),
    onProgress: async (done, queued) => {
      void beat();
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
    return emptyOutcome(runId, true, false);
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
  for (const chunk of chunks([...deduped.values()], INSERT_CHUNK)) {
    const written = await db
      .insert(pageSnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [pageSnapshots.auditRunId, pageSnapshots.normalizedUrl],
        // A retry re-crawled the page: every observed column takes the new value.
        set: Object.fromEntries(
          SNAPSHOT_REFRESH_COLUMNS.map((key) => [key, sqlExcluded(pageSnapshots[key].name)]),
        ),
      })
      .returning({ id: pageSnapshots.id, normalizedUrl: pageSnapshots.normalizedUrl });
    for (const row of written) snapshotIdByUrl.set(row.normalizedUrl, row.id);
  }
  await persistPageDetails(project.id, runId, crawlResult, snapshotIdByUrl);
  await beat();

  // ---- rules -------------------------------------------------------------
  const { findings, groups, perRule } = runRules({
    project: { id: project.id, baseUrl: project.baseUrl, locale: project.locale },
    pages: analyzed,
    sitemapUrls: crawlResult.sitemapUrls,
    robots: crawlResult.robots,
    userAgent,
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

  const drafts = await withoutOpenDuplicates(
    project.id,
    proposalService.draftsFromGroups(project.id, groups, issueIdByFingerprint),
  );
  const created = await proposalService.createProposals({
    orgId: project.orgId,
    actor: { type: "AGENT", id: "agent" },
    drafts,
  });

  // ---- score -------------------------------------------------------------
  const breakdown = computeScore(analyzed, findings);

  // Conditional: a run cancelled while the rules ran stays cancelled.
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
    .where(and(eq(auditRuns.id, runId), eq(auditRuns.status, "RUNNING")));

  await db.update(projects).set({ score: breakdown.score }).where(eq(projects.id, project.id));

  // Keep the platform (CMS, SEO plugin, CDN) current: it decides which ways of
  // connecting the panel recommends. Best effort — never a reason to fail a scan.
  const detectedAt = project.platform?.detectedAt ? Date.parse(project.platform.detectedAt) : 0;
  if (!(Date.now() - detectedAt < PLATFORM_MAX_AGE_MS)) {
    await refreshPlatform(project.id).catch((err: unknown) =>
      log.warn({ err: (err as Error).message }, "platform detection failed"),
    );
  }

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
    skipped: false,
  };
}

/** Internal links kept per page: enough for the link graph without storing every footer link twice. */
const MAX_LINKS_PER_PAGE = 300;
/** Runs whose page details are kept per project; older graphs are pruned. */
const KEEP_DETAIL_RUNS = 3;

/**
 * The crawl graph and page structure (see page_details) for internal linking,
 * schema markup and the sitemap generator. Upserted like the snapshots, so a
 * retried run converges; details of all but the newest runs are pruned.
 */
async function persistPageDetails(
  projectId: string,
  runId: string,
  crawlResult: CrawlResult,
  snapshotIdByUrl: Map<string, string>,
): Promise<void> {
  const rows: Array<typeof pageDetails.$inferInsert> = [];
  const done = new Set<string>();
  for (const page of crawlResult.pages) {
    const snapshotId = snapshotIdByUrl.get(page.normalizedUrl);
    if (!snapshotId || done.has(snapshotId)) continue;
    done.add(snapshotId);
    const x = page.extracted;
    rows.push({
      snapshotId,
      auditRunId: runId,
      projectId,
      links: (x?.links ?? [])
        .filter((l) => l.internal && l.url !== page.normalizedUrl)
        .slice(0, MAX_LINKS_PER_PAGE)
        .map((l) => ({ u: l.url, a: l.anchor.slice(0, 100), ...(l.nofollow ? { nf: 1 as const } : {}) })),
      headings: (x?.headings ?? []).map((h) => ({ l: h.level, t: h.text })),
      jsonLd: x?.jsonLd ?? [],
      images: x?.images ?? [],
      lastModified: page.lastModified ? new Date(page.lastModified) : null,
    });
  }
  for (const chunk of chunks(rows, INSERT_CHUNK)) {
    await db
      .insert(pageDetails)
      .values(chunk)
      .onConflictDoUpdate({
        target: pageDetails.snapshotId,
        set: {
          links: sqlExcluded("links"),
          headings: sqlExcluded("headings"),
          jsonLd: sqlExcluded("json_ld"),
          images: sqlExcluded("images"),
          lastModified: sqlExcluded("last_modified"),
        },
      });
  }
  await db.execute(sql`
    DELETE FROM page_details d
     WHERE d.project_id = ${projectId}
       AND d.audit_run_id <> ${runId}
       AND d.audit_run_id NOT IN (
         SELECT r.id FROM audit_runs r
          WHERE r.project_id = ${projectId} AND r.status = 'SUCCEEDED'
          ORDER BY r.finished_at DESC NULLS LAST
          LIMIT ${KEEP_DETAIL_RUNS - 1}
       )
  `);
}

/**
 * An error no retry can fix: the target itself is refused. The worker should
 * fail such a job without retrying (BullMQ's UnrecoverableError).
 */
export function isPermanentFailure(err: unknown): boolean {
  return err instanceof BlockedAddressError;
}

/**
 * Record a failed attempt. When a retry will follow (`dead === false`) the run
 * goes back to QUEUED with the error kept for display — it still holds the
 * project's one active-run slot, so no second scan can start in between. Only
 * the final attempt, or a permanent failure, ends the run as DEAD_LETTER.
 * Returns whether the run is now final.
 */
export async function markRunFailed(runId: string, err: unknown, dead: boolean): Promise<{ final: boolean }> {
  const message = err instanceof Error ? err.message : String(err);
  const permanent = isPermanentFailure(err);
  const final = dead || permanent;
  const errorCode = permanent ? "BLOCKED_ADDRESS" : final ? "RETRIES_EXHAUSTED" : "ATTEMPT_FAILED";
  await db
    .update(auditRuns)
    .set(
      final
        ? { status: "DEAD_LETTER", error: message.slice(0, 2000), errorCode, finishedAt: new Date() }
        : { status: "QUEUED", error: message.slice(0, 2000), errorCode },
    )
    // A run already finished or cancelled keeps its outcome.
    .where(and(eq(auditRuns.id, runId), inArray(auditRuns.status, ["QUEUED", "RUNNING"])));
  metric(final ? "run.dead_letter" : "run.attempt_failed");
  return { final };
}

/**
 * Drop changes an open proposal already carries, so a retried or repeated run
 * does not queue the same fix twice. Keyed per change, since a proposal groups
 * many.
 */
async function withoutOpenDuplicates(
  projectId: string,
  drafts: ProposalDraft[],
): Promise<ProposalDraft[]> {
  if (drafts.length === 0) return drafts;
  const open = await db
    .select({ ruleId: fixProposals.ruleId, action: fixProposals.action, changes: fixProposals.changes })
    .from(fixProposals)
    .where(
      and(
        eq(fixProposals.projectId, projectId),
        inArray(fixProposals.status, ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "APPLYING"]),
      ),
    );
  const key = (ruleId: string, action: string, c: { url: string; selector?: string }) =>
    JSON.stringify([ruleId, action, c.url, c.selector ?? null]);
  const taken = new Set<string>();
  for (const p of open) {
    for (const c of (p.changes as Array<{ url: string; selector?: string }>) ?? []) taken.add(key(p.ruleId, p.action, c));
  }
  return drafts
    .map((d) => ({ ...d, changes: d.changes.filter((c) => !taken.has(key(d.ruleId, d.action, c))) }))
    .filter((d) => d.changes.length > 0);
}

async function wasCanceled(runId: string): Promise<boolean> {
  const rows = await db
    .select({ status: auditRuns.status })
    .from(auditRuns)
    .where(and(eq(auditRuns.id, runId), eq(auditRuns.status, "CANCELED")))
    .limit(1);
  return rows.length > 0;
}

function emptyOutcome(runId: string, canceled: boolean, skipped: boolean): AnalyzeOutcome {
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
    skipped,
  };
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Everything a crawl observes about a page; ids, keys and the run link are left alone. */
const SNAPSHOT_REFRESH_COLUMNS = [
  "url",
  "depth",
  "statusCode",
  "responseMs",
  "contentHash",
  "bodyBytes",
  "title",
  "titleLength",
  "metaDescription",
  "metaDescriptionLength",
  "h1s",
  "canonical",
  "robotsMeta",
  "xRobotsTag",
  "indexable",
  "noindexReason",
  "lang",
  "wordCount",
  "imagesTotal",
  "imagesMissingAlt",
  "internalLinksOut",
  "internalLinksIn",
  "externalLinksOut",
  "inSitemap",
  "redirectChain",
  "redirectTarget",
  "fetchedAt",
] as const;

/** `excluded.<column>` reference for an upsert's SET clause. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

export type { Project, AuditRun };
