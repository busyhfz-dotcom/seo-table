/**
 * SEO Table — v0.4 schema (Drizzle / PostgreSQL)
 *
 * Two invariants live in the database, not in application code:
 *
 *  1. `issue_occurrences` and `audit_log` are append-only. Migration
 *     0001 installs triggers that reject UPDATE and DELETE (0003 adds the
 *     explicit purge door, 0004 also refuses TRUNCATE), so history cannot be
 *     rewritten even by a buggy caller or a stray script.
 *
 *  2. A project has at most one active audit run. Migration 0001 installs a
 *     partial unique index on (project_id) WHERE status IN ('QUEUED','RUNNING'),
 *     so a second concurrent run fails with a unique violation rather than
 *     relying on a check-then-insert race in the API.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

const id = () =>
  varchar("id", { length: 30 })
    .primaryKey()
    .$defaultFn(() => cuid());

/** Short, sortable, url-safe id. Time prefix keeps index locality. */
export function cuid(): string {
  const t = Date.now().toString(36);
  const r = Array.from({ length: 14 }, () =>
    "0123456789abcdefghijklmnopqrstuvwxyz".charAt(Math.floor(Math.random() * 36)),
  ).join("");
  return `c${t}${r}`;
}

// ---------------------------------------------------------------- enums

export const roleEnum = pgEnum("role", ["OWNER", "ADMIN", "EDITOR", "VIEWER"]);
export const runStatusEnum = pgEnum("run_status", [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "DEAD_LETTER",
]);
export const runTriggerEnum = pgEnum("run_trigger", ["MANUAL", "SCHEDULE", "API", "AGENT"]);
export const severityEnum = pgEnum("severity", ["CRITICAL", "SERIOUS", "WARNING", "INFO"]);
export const issueStatusEnum = pgEnum("issue_status", ["OPEN", "FIXED", "IGNORED"]);
export const occurrenceKindEnum = pgEnum("occurrence_kind", [
  "DETECTED",
  "PERSISTED",
  "RESOLVED",
  "REGRESSED",
]);
export const riskEnum = pgEnum("risk_level", ["LOW", "SENSITIVE", "RESTRICTED"]);
export const fixActionEnum = pgEnum("fix_action", [
  "TITLE_REWRITE",
  "META_REWRITE",
  "H1_FIX",
  "ALT_TEXT",
  "CANONICAL_FIX",
  "ROBOTS_FIX",
  "SITEMAP_ADD",
  "INTERNAL_LINK",
  "REDIRECT",
  "URL_CHANGE",
  "PAGE_MERGE",
]);
export const fixStatusEnum = pgEnum("fix_status", [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "APPLYING",
  "APPLIED",
  "FAILED",
  "ROLLED_BACK",
]);
export const decisionEnum = pgEnum("decision", ["PENDING", "APPROVED", "REJECTED"]);
export const connectorKindEnum = pgEnum("connector_kind", [
  "WORDPRESS",
  "SEARCH_CONSOLE",
  "GA4",
  "INSTAGRAM",
  "YOUTUBE",
]);
export const connectorStatusEnum = pgEnum("connector_status", [
  "NOT_CONNECTED",
  "CONNECTED",
  "ERROR",
]);
export const actorTypeEnum = pgEnum("actor_type", ["USER", "AGENT", "SYSTEM", "API_KEY"]);

// ---------------------------------------------------------------- identity

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    userId: varchar("user_id", { length: 30 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: varchar("org_id", { length: 30 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    // Orders a user's organizations when a session has no org chosen yet. Rows
    // that predate 0004 share one timestamp, so tie-break on the (sortable) id.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memberships_user_org_uq").on(t.userId, t.orgId), index("memberships_org_idx").on(t.orgId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: varchar("user_id", { length: 30 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The organization this session acts in; null for sessions created before 0004. */
    orgId: varchar("org_id", { length: 30 }).references(() => organizations.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_org_idx").on(t.orgId)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    orgId: varchar("org_id", { length: 30 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull().unique(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_keys_org_idx").on(t.orgId)],
);

// ---------------------------------------------------------------- projects

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: varchar("org_id", { length: 30 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    locale: text("locale").notNull().default("fa"),
    pageCap: integer("page_cap").notNull().default(2000),
    crawlRate: integer("crawl_rate").notNull().default(8),
    score: integer("score"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("projects_org_idx").on(t.orgId)],
);

// ---------------------------------------------------------------- audit runs

export const auditRuns = pgTable(
  "audit_runs",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: runStatusEnum("status").notNull().default("QUEUED"),
    trigger: runTriggerEnum("trigger").notNull().default("MANUAL"),
    idempotencyKey: text("idempotency_key").notNull(),
    jobId: text("job_id"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    pagesCrawled: integer("pages_crawled").notNull().default(0),
    pagesTotal: integer("pages_total"),
    score: integer("score"),
    scoreBreakdown: jsonb("score_breakdown"),
    error: text("error"),
    errorCode: text("error_code"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Last sign of life from the worker; the reaper judges staleness by it, not by queue time. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdById: text("created_by_id"),
  },
  (t) => [
    // Replaying POST /scans with the same Idempotency-Key returns the original
    // run instead of enqueueing a duplicate.
    uniqueIndex("audit_runs_project_idem_uq").on(t.projectId, t.idempotencyKey),
    index("audit_runs_project_queued_idx").on(t.projectId, t.queuedAt),
    index("audit_runs_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------- snapshots

export const pageSnapshots = pgTable(
  "page_snapshots",
  {
    id: id(),
    auditRunId: varchar("audit_run_id", { length: 30 })
      .notNull()
      .references(() => auditRuns.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    depth: integer("depth").notNull().default(0),
    statusCode: integer("status_code").notNull(),
    responseMs: integer("response_ms").notNull().default(0),
    contentHash: text("content_hash").notNull(),
    bodyBytes: integer("body_bytes").notNull().default(0),
    title: text("title"),
    titleLength: integer("title_length").notNull().default(0),
    metaDescription: text("meta_description"),
    metaDescriptionLength: integer("meta_description_length").notNull().default(0),
    h1s: jsonb("h1s").notNull().default(sql`'[]'::jsonb`),
    canonical: text("canonical"),
    robotsMeta: text("robots_meta"),
    xRobotsTag: text("x_robots_tag"),
    indexable: boolean("indexable").notNull().default(true),
    noindexReason: text("noindex_reason"),
    lang: text("lang"),
    wordCount: integer("word_count").notNull().default(0),
    imagesTotal: integer("images_total").notNull().default(0),
    imagesMissingAlt: integer("images_missing_alt").notNull().default(0),
    internalLinksOut: integer("internal_links_out").notNull().default(0),
    internalLinksIn: integer("internal_links_in").notNull().default(0),
    externalLinksOut: integer("external_links_out").notNull().default(0),
    inSitemap: boolean("in_sitemap").notNull().default(false),
    redirectChain: jsonb("redirect_chain"),
    redirectTarget: text("redirect_target"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("page_snapshots_run_url_uq").on(t.auditRunId, t.normalizedUrl),
    index("page_snapshots_project_url_idx").on(t.projectId, t.normalizedUrl),
    index("page_snapshots_hash_idx").on(t.contentHash),
  ],
);

// ---------------------------------------------------------------- issues

export const seoIssues = pgTable(
  "seo_issues",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: severityEnum("severity").notNull(),
    status: issueStatusEnum("status").notNull().default("OPEN"),
    title: text("title").notNull(),
    category: text("category").notNull(),
    pageCount: integer("page_count").notNull().default(0),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    firstSeenRunId: text("first_seen_run_id"),
    lastSeenRunId: text("last_seen_run_id"),
    data: jsonb("data"),
  },
  (t) => [
    uniqueIndex("seo_issues_project_fp_uq").on(t.projectId, t.fingerprint),
    index("seo_issues_project_status_idx").on(t.projectId, t.status, t.severity),
  ],
);

/** APPEND-ONLY — see migrations 0001, 0003 and 0004. */
export const issueOccurrences = pgTable(
  "issue_occurrences",
  {
    id: id(),
    issueId: varchar("issue_id", { length: 30 })
      .notNull()
      .references(() => seoIssues.id, { onDelete: "cascade" }),
    auditRunId: varchar("audit_run_id", { length: 30 })
      .notNull()
      .references(() => auditRuns.id, { onDelete: "cascade" }),
    // NO ACTION rather than SET NULL: nulling the column would be an UPDATE, which
    // the append-only trigger refuses. A purge deletes the snapshot and its
    // occurrences in the same statement, so the check passes there.
    pageSnapshotId: varchar("page_snapshot_id", { length: 30 }).references(() => pageSnapshots.id),
    url: text("url").notNull(),
    kind: occurrenceKindEnum("kind").notNull(),
    severity: severityEnum("severity").notNull(),
    evidence: jsonb("evidence"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per (issue, run, url, kind): the worker can retry a run safely
    // without duplicating history.
    uniqueIndex("issue_occurrences_unique").on(t.issueId, t.auditRunId, t.url, t.kind),
    index("issue_occurrences_issue_idx").on(t.issueId, t.observedAt),
    index("issue_occurrences_run_idx").on(t.auditRunId),
  ],
);

// ---------------------------------------------------------------- fixes

export const fixProposals = pgTable(
  "fix_proposals",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueId: varchar("issue_id", { length: 30 }).references(() => seoIssues.id, { onDelete: "set null" }),
    ruleId: text("rule_id").notNull(),
    action: fixActionEnum("action").notNull(),
    risk: riskEnum("risk").notNull(),
    status: fixStatusEnum("status").notNull().default("DRAFT"),
    title: text("title").notNull(),
    rationale: text("rationale"),
    targetCount: integer("target_count").notNull().default(0),
    changes: jsonb("changes").notNull(),
    dryRun: jsonb("dry_run"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("fix_proposals_project_status_idx").on(t.projectId, t.status)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    fixProposalId: varchar("fix_proposal_id", { length: 30 })
      .notNull()
      .unique()
      .references(() => fixProposals.id, { onDelete: "cascade" }),
    decision: decisionEnum("decision").notNull().default("PENDING"),
    requestedBy: text("requested_by").notNull(),
    decidedById: text("decided_by_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("approvals_decision_idx").on(t.decision)],
);

export const fixExecutions = pgTable(
  "fix_executions",
  {
    id: id(),
    fixProposalId: varchar("fix_proposal_id", { length: 30 })
      .notNull()
      .references(() => fixProposals.id, { onDelete: "cascade" }),
    dryRun: boolean("dry_run").notNull().default(false),
    status: fixStatusEnum("status").notNull(),
    appliedCount: integer("applied_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    snapshot: jsonb("snapshot"),
    results: jsonb("results"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  },
  (t) => [index("fix_executions_proposal_idx").on(t.fixProposalId)],
);

// ---------------------------------------------------------------- connectors

export const connectors = pgTable(
  "connectors",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: connectorKindEnum("kind").notNull(),
    status: connectorStatusEnum("status").notNull().default("NOT_CONNECTED"),
    // AES-256-GCM. Never logged, never returned by any API response.
    secretCipher: text("secret_cipher"),
    secretIv: text("secret_iv"),
    secretTag: text("secret_tag"),
    config: jsonb("config"),
    scopes: jsonb("scopes").notNull().default(sql`'[]'::jsonb`),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("connectors_project_kind_uq").on(t.projectId, t.kind)],
);

/**
 * Filled only from a live Search Console connector. Zero rows means no data —
 * nothing in this table is ever synthesised.
 */
export const contentOpportunities = pgTable(
  "content_opportunities",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    url: text("url"),
    impressions: integer("impressions").notNull(),
    clicks: integer("clicks").notNull(),
    ctr: doublePrecision("ctr").notNull(),
    position: doublePrecision("position").notNull(),
    gap: severityEnum("gap").notNull(),
    suggestedAction: text("suggested_action").notNull(),
    source: text("source").notNull().default("SEARCH_CONSOLE"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_opps_uq").on(t.projectId, t.query, t.periodStart),
    index("content_opps_project_idx").on(t.projectId, t.impressions),
  ],
);

// ---------------------------------------------------------------- audit log

/** APPEND-ONLY — see migrations 0001, 0003 and 0004. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    orgId: varchar("org_id", { length: 30 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_org_idx").on(t.orgId, t.createdAt), index("audit_log_action_idx").on(t.action)],
);

// ---------------------------------------------------------------- relations

export const projectsRelations = relations(projects, ({ many, one }) => ({
  org: one(organizations, { fields: [projects.orgId], references: [organizations.id] }),
  runs: many(auditRuns),
  issues: many(seoIssues),
  connectors: many(connectors),
}));

export const auditRunsRelations = relations(auditRuns, ({ one, many }) => ({
  project: one(projects, { fields: [auditRuns.projectId], references: [projects.id] }),
  snapshots: many(pageSnapshots),
  occurrences: many(issueOccurrences),
}));

export const seoIssuesRelations = relations(seoIssues, ({ one, many }) => ({
  project: one(projects, { fields: [seoIssues.projectId], references: [projects.id] }),
  occurrences: many(issueOccurrences),
  proposals: many(fixProposals),
}));

export const fixProposalsRelations = relations(fixProposals, ({ one, many }) => ({
  project: one(projects, { fields: [fixProposals.projectId], references: [projects.id] }),
  approval: one(approvals),
  executions: many(fixExecutions),
}));

export type Project = typeof projects.$inferSelect;
export type AuditRun = typeof auditRuns.$inferSelect;
export type PageSnapshot = typeof pageSnapshots.$inferSelect;
export type NewPageSnapshot = typeof pageSnapshots.$inferInsert;
export type SeoIssue = typeof seoIssues.$inferSelect;
export type IssueOccurrence = typeof issueOccurrences.$inferSelect;
export type FixProposal = typeof fixProposals.$inferSelect;
export type Connector = typeof connectors.$inferSelect;
export type Severity = (typeof severityEnum.enumValues)[number];
export type ConnectorKind = (typeof connectorKindEnum.enumValues)[number];
export type ConnectorStatus = (typeof connectorStatusEnum.enumValues)[number];
export type RunStatus = (typeof runStatusEnum.enumValues)[number];
export type RunTrigger = (typeof runTriggerEnum.enumValues)[number];
export type IssueStatus = (typeof issueStatusEnum.enumValues)[number];
export type OccurrenceKind = (typeof occurrenceKindEnum.enumValues)[number];
export type FixStatus = (typeof fixStatusEnum.enumValues)[number];
export type Decision = (typeof decisionEnum.enumValues)[number];
export type ActorType = (typeof actorTypeEnum.enumValues)[number];
export type RiskLevel = (typeof riskEnum.enumValues)[number];
export type FixAction = (typeof fixActionEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
