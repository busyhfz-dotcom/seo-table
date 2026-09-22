/**
 * Every read in the product goes through this module — server components and API
 * routes alike. One place to scope a query to an organization, one place where
 * pagination and sorting happen in SQL rather than in the browser.
 *
 * There is no fixture, sample or placeholder data anywhere in here. A screen with
 * nothing to show renders its empty state.
 */
import {
  and,
  approvals,
  auditLog,
  auditRuns,
  connectors,
  contentOpportunities,
  db,
  desc,
  eq,
  fixProposals,
  inArray,
  isNotNull,
  issueOccurrences,
  organizations,
  pageSnapshots,
  projects,
  seoIssues,
  sql,
  type AuditRun,
  type Connector,
  type FixProposal,
  type Project,
  type Severity,
} from "@seo/db";
import { queueDepth, pingRedis } from "@seo/core";
import { pingDb } from "@seo/db";

// ---------------------------------------------------------------- projects

export async function listProjects(orgId: string): Promise<
  Array<Project & { openIssues: number; lastRun: AuditRun | null }>
> {
  const rows = await db.select().from(projects).where(eq(projects.orgId, orgId)).orderBy(projects.name);
  if (rows.length === 0) return [];

  const ids = rows.map((p) => p.id);
  const counts = await db
    .select({ projectId: seoIssues.projectId, n: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(and(inArray(seoIssues.projectId, ids), eq(seoIssues.status, "OPEN")))
    .groupBy(seoIssues.projectId);
  const countByProject = new Map(counts.map((c) => [c.projectId, c.n]));

  // Only each project's newest run, chosen in SQL: a project with thousands of
  // runs must not load them all to show one.
  const latest = await db
    .selectDistinctOn([auditRuns.projectId])
    .from(auditRuns)
    .where(inArray(auditRuns.projectId, ids))
    .orderBy(auditRuns.projectId, desc(auditRuns.queuedAt), desc(auditRuns.id));
  const lastByProject = new Map(latest.map((run) => [run.projectId, run]));

  return rows.map((p) => ({
    ...p,
    openIssues: countByProject.get(p.id) ?? 0,
    lastRun: lastByProject.get(p.id) ?? null,
  }));
}

export async function getProject(orgId: string, projectId: string): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

/** The project a screen shows when the user has not picked one. */
export async function defaultProject(orgId: string): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId))
    .orderBy(projects.createdAt)
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- dashboard

export type DashboardData = {
  project: Project | null;
  latestRun: AuditRun | null;
  previousRun: AuditRun | null;
  indexablePages: number;
  crawledPages: number;
  openIssues: number;
  pendingApprovals: number;
  severity: Array<{ severity: Severity; count: number }>;
  trend: Array<{ at: Date; score: number }>;
  recentRuns: AuditRun[];
  activity: Array<{ action: string; actorType: string; createdAt: Date; metadata: unknown; targetId: string | null }>;
};

export async function dashboard(orgId: string, projectId?: string): Promise<DashboardData> {
  const project = projectId ? await getProject(orgId, projectId) : await defaultProject(orgId);
  if (!project) {
    return {
      project: null,
      latestRun: null,
      previousRun: null,
      indexablePages: 0,
      crawledPages: 0,
      openIssues: 0,
      pendingApprovals: 0,
      severity: [],
      trend: [],
      recentRuns: [],
      activity: [],
    };
  }

  const recentRuns = await db
    .select()
    .from(auditRuns)
    .where(eq(auditRuns.projectId, project.id))
    .orderBy(desc(auditRuns.queuedAt))
    .limit(10);

  const succeeded = recentRuns.filter((r) => r.status === "SUCCEEDED");
  const latestRun = recentRuns[0] ?? null;
  const latestSucceeded = succeeded[0] ?? null;
  const previousRun = succeeded[1] ?? null;

  const [pageStats] = latestSucceeded
    ? await db
        .select({
          crawled: sql<number>`count(*)::int`,
          indexable: sql<number>`count(*) filter (where ${pageSnapshots.indexable})::int`,
        })
        .from(pageSnapshots)
        .where(eq(pageSnapshots.auditRunId, latestSucceeded.id))
    : [{ crawled: 0, indexable: 0 }];

  const severityRows = await db
    .select({ severity: seoIssues.severity, count: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(and(eq(seoIssues.projectId, project.id), eq(seoIssues.status, "OPEN")))
    .groupBy(seoIssues.severity);

  const [{ pending } = { pending: 0 }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(fixProposals)
    .where(
      and(eq(fixProposals.projectId, project.id), eq(fixProposals.status, "AWAITING_APPROVAL")),
    );

  const trendRows = await db
    .select({ at: auditRuns.finishedAt, score: auditRuns.score })
    .from(auditRuns)
    .where(
      and(eq(auditRuns.projectId, project.id), eq(auditRuns.status, "SUCCEEDED"), isNotNull(auditRuns.finishedAt)),
    )
    .orderBy(desc(auditRuns.finishedAt))
    .limit(60);
  // The newest 60, shown oldest-first.
  trendRows.reverse();

  const activity = await db
    .select({
      action: auditLog.action,
      actorType: auditLog.actorType,
      createdAt: auditLog.createdAt,
      metadata: auditLog.metadata,
      targetId: auditLog.targetId,
    })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .orderBy(desc(auditLog.createdAt))
    .limit(12);

  return {
    project,
    latestRun,
    previousRun,
    indexablePages: pageStats?.indexable ?? 0,
    crawledPages: pageStats?.crawled ?? 0,
    openIssues: severityRows.reduce((s, r) => s + r.count, 0),
    pendingApprovals: pending,
    severity: (["CRITICAL", "SERIOUS", "WARNING", "INFO"] as Severity[]).map((severity) => ({
      severity,
      count: severityRows.find((r) => r.severity === severity)?.count ?? 0,
    })),
    trend: trendRows
      .filter((r): r is { at: Date; score: number } => r.at !== null && r.score !== null)
      .map((r) => ({ at: r.at, score: r.score })),
    recentRuns,
    activity,
  };
}

// ---------------------------------------------------------------- runs

export async function getRun(orgId: string, runId: string): Promise<(AuditRun & { project: Project }) | null> {
  const rows = await db
    .select({ run: auditRuns, project: projects })
    .from(auditRuns)
    .innerJoin(projects, eq(projects.id, auditRuns.projectId))
    .where(and(eq(auditRuns.id, runId), eq(projects.orgId, orgId)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.run, project: row.project } : null;
}

export async function latestRunFor(projectId: string): Promise<AuditRun | null> {
  const rows = await db
    .select()
    .from(auditRuns)
    .where(eq(auditRuns.projectId, projectId))
    .orderBy(desc(auditRuns.queuedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function runPages(
  runId: string,
  opts: { limit?: number; offset?: number; onlyProblems?: boolean } = {},
) {
  const where = opts.onlyProblems
    ? and(eq(pageSnapshots.auditRunId, runId), eq(pageSnapshots.indexable, false))
    : eq(pageSnapshots.auditRunId, runId);

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(pageSnapshots)
      .where(where)
      .orderBy(pageSnapshots.depth, pageSnapshots.normalizedUrl)
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0),
    db.select({ total: sql<number>`count(*)::int` }).from(pageSnapshots).where(where),
  ]);
  return { rows, total };
}

/** Per-page issue counts for the run's Pages tab. */
export async function issueCountsByUrl(runId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ url: issueOccurrences.url, n: sql<number>`count(*)::int` })
    .from(issueOccurrences)
    .where(and(eq(issueOccurrences.auditRunId, runId), inArray(issueOccurrences.kind, ["DETECTED", "PERSISTED", "REGRESSED"])))
    .groupBy(issueOccurrences.url);
  return new Map(rows.map((r) => [r.url, r.n]));
}

// ---------------------------------------------------------------- issues

export type IssueFilter = {
  severity?: Severity;
  status?: "OPEN" | "FIXED" | "IGNORED";
  category?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export async function listIssues(projectId: string, filter: IssueFilter = {}) {
  const clauses = [eq(seoIssues.projectId, projectId)];
  if (filter.severity) clauses.push(eq(seoIssues.severity, filter.severity));
  clauses.push(eq(seoIssues.status, filter.status ?? "OPEN"));
  if (filter.category) clauses.push(eq(seoIssues.category, filter.category));
  if (filter.q) clauses.push(sql`(${seoIssues.title} ilike ${"%" + filter.q + "%"} or ${seoIssues.ruleId} ilike ${"%" + filter.q + "%"})`);
  const where = and(...clauses);

  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(seoIssues)
      .where(where)
      .orderBy(
        // Severity is an enum, so order it explicitly rather than alphabetically.
        sql`case ${seoIssues.severity} when 'CRITICAL' then 4 when 'SERIOUS' then 3 when 'WARNING' then 2 else 1 end desc`,
        desc(seoIssues.pageCount),
      )
      .limit(filter.limit ?? 50)
      .offset(filter.offset ?? 0),
    db.select({ total: sql<number>`count(*)::int` }).from(seoIssues).where(where),
  ]);
  return { rows, total };
}

export async function getIssue(projectId: string, issueId: string) {
  const rows = await db
    .select()
    .from(seoIssues)
    .where(and(eq(seoIssues.id, issueId), eq(seoIssues.projectId, projectId)))
    .limit(1);
  const issue = rows[0];
  if (!issue) return null;

  const [timeline, proposals, affected] = await Promise.all([
    db
      .select()
      .from(issueOccurrences)
      .where(eq(issueOccurrences.issueId, issue.id))
      .orderBy(desc(issueOccurrences.observedAt))
      .limit(40),
    db.select().from(fixProposals).where(eq(fixProposals.issueId, issue.id)),
    db
      .select({ url: issueOccurrences.url })
      .from(issueOccurrences)
      .where(eq(issueOccurrences.issueId, issue.id))
      .groupBy(issueOccurrences.url)
      .limit(50),
  ]);

  return { issue, timeline, proposals, affected: affected.map((a) => a.url) };
}

/** The highest-severity open issue, used as the detail pane's default. */
export async function firstIssue(projectId: string) {
  const { rows } = await listIssues(projectId, { limit: 1 });
  const first = rows[0];
  return first ? getIssue(projectId, first.id) : null;
}

export async function issueCategories(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ category: seoIssues.category })
    .from(seoIssues)
    .where(eq(seoIssues.projectId, projectId))
    .groupBy(seoIssues.category)
    .orderBy(seoIssues.category);
  return rows.map((r) => r.category);
}

// ---------------------------------------------------------------- fixes

export async function listFixes(
  projectId: string,
  statuses?: FixProposal["status"][],
): Promise<Array<FixProposal & { decision: string | null }>> {
  const where = statuses?.length
    ? and(eq(fixProposals.projectId, projectId), inArray(fixProposals.status, statuses))
    : eq(fixProposals.projectId, projectId);

  const rows = await db
    .select({ proposal: fixProposals, decision: approvals.decision })
    .from(fixProposals)
    .leftJoin(approvals, eq(approvals.fixProposalId, fixProposals.id))
    .where(where)
    .orderBy(desc(fixProposals.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r.proposal, decision: r.decision ?? null }));
}

export async function listApprovalQueue(projectId: string, limit = 200) {
  const rows = await db
    .select({ proposal: fixProposals, approval: approvals, issue: seoIssues })
    .from(fixProposals)
    .leftJoin(approvals, eq(approvals.fixProposalId, fixProposals.id))
    .leftJoin(seoIssues, eq(seoIssues.id, fixProposals.issueId))
    .where(
      and(eq(fixProposals.projectId, projectId), eq(fixProposals.status, "AWAITING_APPROVAL")),
    )
    .orderBy(desc(fixProposals.createdAt))
    .limit(limit);
  return rows;
}

/**
 * A proposal looked up by id and scoped to the organization, not to a guessed
 * project — the caller only knows the proposal id, and the org check is what stops
 * one tenant from acting on another's fix.
 */
export async function getFixForOrg(orgId: string, id: string) {
  const rows = await db
    .select({ proposal: fixProposals, approval: approvals, project: projects })
    .from(fixProposals)
    .innerJoin(projects, eq(projects.id, fixProposals.projectId))
    .leftJoin(approvals, eq(approvals.fixProposalId, fixProposals.id))
    .where(and(eq(fixProposals.id, id), eq(projects.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getFix(projectId: string, id: string) {
  const rows = await db
    .select({ proposal: fixProposals, approval: approvals })
    .from(fixProposals)
    .leftJoin(approvals, eq(approvals.fixProposalId, fixProposals.id))
    .where(and(eq(fixProposals.id, id), eq(fixProposals.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- connectors

export async function listConnectors(projectId: string): Promise<Connector[]> {
  return db.select().from(connectors).where(eq(connectors.projectId, projectId));
}

// ---------------------------------------------------------------- content

const DAY_MS = 86_400_000;

/**
 * The Search Console window a sync stores: the 28 days ending two days ago
 * (Search Console lags ~2 days), on UTC day boundaries. Every sync on the same
 * day lands on the same period_start, so it refreshes the stored rows instead of
 * adding a near-duplicate set per request.
 */
export function opportunityPeriod(now: Date): { start: Date; end: Date } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = new Date(today - 2 * DAY_MS);
  return { start: new Date(end.getTime() - 28 * DAY_MS), end };
}

/** Opportunities from the most recent synced period only; older periods are history. */
export async function listOpportunities(projectId: string, limit = 50) {
  const latestPeriod = db
    .select({ at: sql`max(${contentOpportunities.periodStart})` })
    .from(contentOpportunities)
    .where(eq(contentOpportunities.projectId, projectId));
  return db
    .select()
    .from(contentOpportunities)
    .where(
      and(
        eq(contentOpportunities.projectId, projectId),
        eq(contentOpportunities.periodStart, sql`(${latestPeriod})`),
      ),
    )
    .orderBy(desc(contentOpportunities.impressions))
    .limit(limit);
}

// ---------------------------------------------------------------- audit log

export async function listAuditLog(orgId: string, limit = 100) {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

export async function orgMembers(orgId: string) {
  const rows = await db.execute(sql`
    select u.id, u.email, u.name, m.role
    from memberships m
    join users u on u.id = m.user_id
    where m.org_id = ${orgId}
    order by
      case m.role when 'OWNER' then 1 when 'ADMIN' then 2 when 'EDITOR' then 3 else 4 end,
      u.email
  `);
  return rows.rows as Array<{ id: string; email: string; name: string | null; role: string }>;
}

export async function getOrg(orgId: string) {
  const rows = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- health

export type HealthSnapshot = {
  database: boolean;
  redis: boolean;
  queue: Awaited<ReturnType<typeof queueDepth>> | null;
};

export async function health(): Promise<HealthSnapshot> {
  const [database, redis] = await Promise.all([
    pingDb().catch(() => false),
    pingRedis().catch(() => false),
  ]);
  const queue = redis ? await queueDepth().catch(() => null) : null;
  return { database, redis, queue };
}
