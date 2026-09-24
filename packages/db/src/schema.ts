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
  check,
  customType,
  date,
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
  // 0008: site-level changes applied as whole documents (edge overrides).
  "SCHEMA_MARKUP",
  "ROBOTS_TXT",
  "SITEMAP_XML",
  // 0009: social profiles (Instagram, Telegram). What people read about the
  // page or channel, and posts published in its name: always a person's call.
  "SOCIAL_PROFILE_NAME",
  "SOCIAL_BIO",
  "SOCIAL_TITLE",
  "SOCIAL_DESCRIPTION",
  "SOCIAL_POST",
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
  "CLOUDFLARE",
  // 0009: a Telegram channel managed through a bot; the fix executor writes
  // channel title/description through it and rollback must use it too.
  "TELEGRAM",
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
  /** White-label brand for generated reports; null = the organization's name, default colour, no logo. */
  reportBrand: jsonb("report_brand").$type<ReportBrand | null>(),
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
    /**
     * Where fixes are written: 'WORDPRESS' | 'CLOUDFLARE'. NULL means automatic —
     * Cloudflare's edge when that connector is connected, otherwise WordPress.
     */
    writeTarget: text("write_target").$type<WriteTarget>(),
    /** Last platform detection (CMS, SEO plugin, CDN); null until first detected. */
    platform: jsonb("platform").$type<PlatformInfo>(),
    /**
     * What the project is about (0009). A social project's base_url is its
     * public profile address, kept for display only: nothing crawls it.
     */
    kind: text("kind").notNull().default("WEBSITE").$type<ProjectKind>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("projects_org_idx").on(t.orgId),
    check("projects_write_target_ck", sql`${t.writeTarget} IS NULL OR ${t.writeTarget} IN ('WORDPRESS', 'CLOUDFLARE')`),
    check("projects_kind_ck", sql`${t.kind} IN ('WEBSITE', 'INSTAGRAM', 'TELEGRAM')`),
  ],
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
    // Click depth from the home page; null for pages reached only via the
    // sitemap or a canonical, where no click path exists.
    depth: integer("depth"),
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

/**
 * What a scan saw on a page beyond the snapshot's columns: its internal links
 * (the crawl graph), headings, JSON-LD blocks, images and Last-Modified header.
 * One row per snapshot, kept in its own table so the many queries that read
 * whole snapshot rows do not drag these documents along, and so it can be
 * pruned to the latest runs (the graph of a run from last year helps nobody).
 * Rows exist for scans from migration 0008 on; older runs have none.
 */
export const pageDetails = pgTable(
  "page_details",
  {
    snapshotId: varchar("snapshot_id", { length: 30 })
      .primaryKey()
      .references(() => pageSnapshots.id, { onDelete: "cascade" }),
    auditRunId: varchar("audit_run_id", { length: 30 })
      .notNull()
      .references(() => auditRuns.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Internal links, normalised, capped per page: {u: url, a: anchor, nf?: nofollow}. */
    links: jsonb("links").notNull().default(sql`'[]'::jsonb`).$type<PageLink[]>(),
    /** h1–h6 in document order, capped: {l: level, t: text}. */
    headings: jsonb("headings").notNull().default(sql`'[]'::jsonb`).$type<PageHeading[]>(),
    /** Parsed JSON-LD blocks as the page serves them, capped by size. */
    jsonLd: jsonb("json_ld").notNull().default(sql`'[]'::jsonb`).$type<unknown[]>(),
    /** Content images, absolute src, capped: {src, alt} (alt null = attribute missing). */
    images: jsonb("images").notNull().default(sql`'[]'::jsonb`).$type<PageImage[]>(),
    /** The Last-Modified response header, when the server sent a valid one. */
    lastModified: timestamp("last_modified", { withTimezone: true }),
  },
  (t) => [index("page_details_run_idx").on(t.auditRunId), index("page_details_project_idx").on(t.projectId)],
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
    /**
     * The connector the writes went through. Rollback must use the same one: an
     * edge override is not undone by writing to WordPress. NULL on rows written
     * before 0006, which were all WordPress.
     */
    connectorKind: connectorKindEnum("connector_kind"),
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

// ---------------------------------------------------------------- phase 2: SEO data
//
// Every metric row carries its source ('gsc', 'dataforseo', 'autocomplete',
// PageSpeed) so the panel can label it, and nothing here is ever synthesised:
// a table without a configured source stays empty.

/** Postgres bytea as a Node Buffer (drizzle has no built-in for it). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const keywords = pgTable(
  "keywords",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phrase: text("phrase").notNull(),
    locale: text("locale").notNull().default("fa"),
    /** ISO 3166-1 alpha-2, upper case. */
    country: varchar("country", { length: 2 }).notNull().default("IR"),
    /** null = all devices. */
    device: text("device").$type<KeywordDevice | null>(),
    targetUrl: text("target_url"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    // coalesce: a NULL device ("all devices") must collide with another NULL,
    // which a plain unique index would let through.
    uniqueIndex("keywords_project_phrase_uq").on(t.projectId, sql`lower(${t.phrase})`, t.country, sql`coalesce(${t.device}, '')`),
    index("keywords_project_idx").on(t.projectId, t.archivedAt),
    check("keywords_device_ck", sql`${t.device} IS NULL OR ${t.device} IN ('desktop', 'mobile')`),
    check("keywords_country_ck", sql`${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

export const keywordPositions = pgTable(
  "keyword_positions",
  {
    id: id(),
    keywordId: varchar("keyword_id", { length: 30 })
      .notNull()
      .references(() => keywords.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    source: text("source").notNull().$type<PositionSource>(),
    /** gsc: average position that day; dataforseo: the organic rank (rank_group). null = not in the results. */
    position: doublePrecision("position"),
    /** The page that ranked (dataforseo), or the page with most impressions over the synced window (gsc). */
    url: text("url"),
    clicks: integer("clicks"),
    impressions: integer("impressions"),
    ctr: doublePrecision("ctr"),
    serpFeatures: text("serp_features").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("keyword_positions_uq").on(t.keywordId, t.date, t.source),
    check("keyword_positions_source_ck", sql`${t.source} IN ('gsc', 'dataforseo')`),
  ],
);

/** Cache of keyword ideas per seed; refreshed when older than the source's TTL. */
export const keywordIdeas = pgTable(
  "keyword_ideas",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seed: text("seed").notNull(),
    idea: text("idea").notNull(),
    source: text("source").notNull().$type<IdeaSource>(),
    /** Suggestions differ by language and market, so they are part of the cache key. */
    locale: text("locale").notNull().default("fa"),
    country: varchar("country", { length: 2 }).notNull().default("IR"),
    /** Only dataforseo fills these; autocomplete and gsc ideas have no volume data. */
    volume: integer("volume"),
    difficulty: integer("difficulty"),
    cpc: doublePrecision("cpc"),
    /** gsc ideas: the query's metrics over the period that produced it. */
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    position: doublePrecision("position"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("keyword_ideas_uq").on(t.projectId, t.seed, t.idea, t.source, t.locale, t.country),
    index("keyword_ideas_lookup_idx").on(t.projectId, t.source, t.seed, t.createdAt),
    check("keyword_ideas_source_ck", sql`${t.source} IN ('autocomplete', 'gsc', 'dataforseo')`),
  ],
);

export const competitors = pgTable(
  "competitors",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Bare host, lower case, no scheme ("rival.example"). */
    domain: text("domain").notNull(),
    name: text("name"),
    /**
     * The project's own site, sampled by the same code and at the same time as
     * its competitors so the comparison is like for like. Hidden from lists;
     * one per project.
     */
    isSelf: boolean("is_self").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("competitors_project_domain_uq").on(t.projectId, t.domain),
    uniqueIndex("competitors_one_self_uq").on(t.projectId).where(sql`${t.isSelf}`),
  ],
);

export const competitorSnapshots = pgTable(
  "competitor_snapshots",
  {
    id: id(),
    competitorId: varchar("competitor_id", { length: 30 })
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    statusCode: integer("status_code").notNull(),
    title: text("title"),
    metaDescription: text("meta_description"),
    h1: text("h1").array().notNull().default(sql`'{}'::text[]`),
    /** {counts: {h1..h6}, h2: string[] (first 20)} */
    headings: jsonb("headings").$type<HeadingSummary>(),
    wordCount: integer("word_count").notNull().default(0),
    schemaTypes: text("schema_types").array().notNull().default(sql`'{}'::text[]`),
    internalLinks: integer("internal_links").notNull().default(0),
    externalLinks: integer("external_links").notNull().default(0),
    /** From PageSpeed Insights (mobile lab), homepage only. */
    lcpMs: integer("lcp_ms"),
    cls: doublePrecision("cls"),
  },
  (t) => [index("competitor_snapshots_idx").on(t.competitorId, t.fetchedAt)],
);

export const pageSpeed = pgTable(
  "page_speed",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    strategy: text("strategy").notNull().$type<PageSpeedStrategy>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    /** Lighthouse performance score 0–100 (lab). */
    performanceScore: integer("performance_score"),
    lcpMs: integer("lcp_ms"),
    cls: doublePrecision("cls"),
    /** Lab runs have no INP; filled from CrUX field data when Google has it. */
    inpMs: integer("inp_ms"),
    ttfbMs: integer("ttfb_ms"),
    fcpMs: integer("fcp_ms"),
    tbtMs: integer("tbt_ms"),
    /** CrUX 75th percentiles and categories; null when Google has too little traffic data. */
    fieldData: jsonb("field_data").$type<CruxFieldData | null>(),
    /** Top Lighthouse opportunities by estimated savings. */
    opportunities: jsonb("opportunities").notNull().default(sql`'[]'::jsonb`).$type<PageSpeedOpportunity[]>(),
  },
  (t) => [
    index("page_speed_project_url_idx").on(t.projectId, t.url, t.strategy, t.fetchedAt),
    check("page_speed_strategy_ck", sql`${t.strategy} IN ('mobile', 'desktop')`),
  ],
);

export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<ScheduleKind>(),
    /** Five-field cron, evaluated in `timezone`. */
    cron: text("cron").notNull(),
    /** IANA zone name; UTC unless the user picks another. */
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Absolute UTC instant; null until the scheduler first computes it. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("schedules_project_kind_uq").on(t.projectId, t.kind),
    index("schedules_due_idx").on(t.enabled, t.nextRunAt),
    check("schedules_kind_ck", sql`${t.kind} IN ('scan', 'rank', 'pagespeed', 'competitors', 'report', 'social_sync')`),
  ],
);

export const alertRules = pgTable(
  "alert_rules",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<AlertKind>(),
    /** Meaning depends on kind (points, positions, percent); null where the kind has none. */
    threshold: doublePrecision("threshold"),
    channels: text("channels").array().notNull().default(sql`'{in_app}'::text[]`).$type<AlertChannel[]>(),
    webhookUrl: text("webhook_url"),
    // HMAC key for the webhook signature, sealed like connector credentials.
    webhookSecretCipher: text("webhook_secret_cipher"),
    webhookSecretIv: text("webhook_secret_iv"),
    webhookSecretTag: text("webhook_secret_tag"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("alert_rules_project_idx").on(t.projectId, t.kind),
    check(
      "alert_rules_kind_ck",
      sql`${t.kind} IN ('score_drop', 'new_critical', 'rank_drop', 'page_down', 'cwv_regression', 'index_drop', 'follower_drop', 'engagement_drop', 'token_expiring', 'publish_failed')`,
    ),
    check("alert_rules_channels_ck", sql`${t.channels} <@ ARRAY['in_app', 'webhook', 'telegram']::text[]`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: varchar("org_id", { length: 30 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 30 }).references(() => projects.id, { onDelete: "cascade" }),
    alertRuleId: varchar("alert_rule_id", { length: 30 }).references(() => alertRules.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    severity: severityEnum("severity").notNull(),
    title: jsonb("title").notNull().$type<LocalizedText>(),
    body: jsonb("body").notNull().$type<LocalizedText>(),
    /** In-app path, e.g. "/keywords?project=…". */
    link: text("link"),
    /** Machine-readable facts behind the text (scores, keyword ids, …). */
    data: jsonb("data"),
    /** One notification per event, whatever retries happen ("score_drop:<runId>"). */
    dedupeKey: text("dedupe_key"),
    /** Per external channel: {status: 'pending'|'sent'|'failed', attempts, error?, at}. */
    deliveries: jsonb("deliveries").notNull().default(sql`'{}'::jsonb`).$type<Record<string, NotificationDelivery>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("notifications_dedupe_uq").on(t.orgId, t.dedupeKey),
    index("notifications_org_idx").on(t.orgId, t.createdAt),
    index("notifications_unread_idx").on(t.orgId).where(sql`${t.readAt} IS NULL`),
  ],
);

/** Organization-wide paid/optional data sources. Credentials sealed like connectors. */
export const orgIntegrations = pgTable(
  "org_integrations",
  {
    id: id(),
    orgId: varchar("org_id", { length: 30 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<IntegrationKind>(),
    secretCipher: text("secret_cipher"),
    secretIv: text("secret_iv"),
    secretTag: text("secret_tag"),
    /** Non-secret settings and the last check's facts (balance, bot name, chat id). */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
    status: connectorStatusEnum("status").notNull().default("NOT_CONNECTED"),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_integrations_org_kind_uq").on(t.orgId, t.kind),
    check("org_integrations_kind_ck", sql`${t.kind} IN ('DATAFORSEO', 'PAGESPEED', 'TELEGRAM_ALERTS')`),
  ],
);

/** Spend ledger for paid providers, so the panel can show what research has cost. */
export const providerUsage = pgTable(
  "provider_usage",
  {
    id: id(),
    orgId: varchar("org_id", { length: 30 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 30 }).references(() => projects.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    /** In the provider's currency (DataForSEO: USD), as the provider reported it. */
    cost: doublePrecision("cost"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("provider_usage_org_idx").on(t.orgId, t.createdAt)],
);

export const contentDocuments = pgTable(
  "content_documents",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    targetKeyword: text("target_keyword"),
    locale: text("locale").notNull().default("fa"),
    /** Sanitised HTML. */
    body: text("body").notNull().default(""),
    score: integer("score"),
    analysis: jsonb("analysis"),
    url: text("url"),
    /** The SEO title and meta description the document is written for (0008). */
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    /** WordPress publishing: the request, its decision and outcome (see content/publish.ts). */
    publish: jsonb("publish").$type<ContentPublishState | null>(),
    createdById: text("created_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("content_documents_project_idx").on(t.projectId, t.updatedAt)],
);

/**
 * Generated PDF reports. The file lives in `content` (bytea): the deployment
 * has no object storage, and a 10 MB cap (enforced by a CHECK) keeps rows sane.
 * `fileKey` is the download file name.
 */
export const REPORT_MAX_BYTES = 10 * 1024 * 1024;
export const reports = pgTable(
  "reports",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<ReportKind>(),
    runId: varchar("run_id", { length: 30 }).references(() => auditRuns.id, { onDelete: "set null" }),
    fileKey: text("file_key").notNull(),
    contentType: text("content_type").notNull().default("application/pdf"),
    bytes: integer("bytes").notNull(),
    content: bytea("content").notNull(),
    /** {logo?: data URL, name?, color?} */
    brand: jsonb("brand").$type<ReportBrand | null>(),
    createdById: text("created_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reports_project_idx").on(t.projectId, t.createdAt),
    check("reports_kind_ck", sql`${t.kind} IN ('audit', 'executive', 'keywords')`),
    check("reports_size_ck", sql`octet_length(${t.content}) <= 10485760 AND ${t.bytes} = octet_length(${t.content})`),
  ],
);

// ---------------------------------------------------------------- 0009: social profiles
//
// An Instagram page or a Telegram channel is a project of its own kind. What
// the platforms report is stored with its source ('api' = the platform's own
// API with the owner's authorization, 'public_preview' = Telegram's public web
// preview t.me/s/<channel>); nothing here is estimated or filled in.

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .unique()
      .references(() => projects.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().$type<SocialPlatform>(),
    /** Instagram user id (Instagram Login) or Telegram chat id ("-100…"). */
    externalId: text("external_id"),
    username: text("username"),
    displayName: text("display_name"),
    /** Instagram biography or Telegram channel description. */
    bio: text("bio"),
    /** Instagram profile website; Telegram has none (links live in the description). */
    website: text("website"),
    /** Platform facts: picture, account type, bot identity and rights, pinned message, webhook mode. */
    profile: jsonb("profile").notNull().default(sql`'{}'::jsonb`).$type<SocialProfile>(),
    /** What the owner wants to be found for, CTA and link; drives the audit's suggestions. */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`).$type<SocialSettings>(),
    followers: integer("followers"),
    following: integer("following"),
    mediaCount: integer("media_count"),
    // Instagram access token or Telegram bot token, AES-256-GCM like connectors.
    secretCipher: text("secret_cipher"),
    secretIv: text("secret_iv"),
    secretTag: text("secret_tag"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    tokenRefreshedAt: timestamp("token_refreshed_at", { withTimezone: true }),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    status: connectorStatusEnum("status").notNull().default("NOT_CONNECTED"),
    lastError: text("last_error"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    connectedById: text("connected_by_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("social_accounts_external_idx").on(t.platform, t.externalId),
    check("social_accounts_platform_ck", sql`${t.platform} IN ('INSTAGRAM', 'TELEGRAM')`),
  ],
);

export const socialPosts = pgTable(
  "social_posts",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().$type<SocialPlatform>(),
    /** Instagram media id, or the Telegram message id. */
    externalId: text("external_id").notNull(),
    permalink: text("permalink"),
    type: text("type").notNull().$type<SocialPostType>(),
    caption: text("caption"),
    mediaUrls: text("media_urls").array().notNull().default(sql`'{}'::text[]`),
    /** Per image, in media order; null entries = no alt text. Empty when the API does not report it. */
    altTexts: text("alt_texts").array(),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** {likes, comments, saves, shares, reach, views, interactions}; absent keys = not reported. */
    metrics: jsonb("metrics").notNull().default(sql`'{}'::jsonb`).$type<SocialPostMetrics>(),
    metricsAt: timestamp("metrics_at", { withTimezone: true }),
    /** {formatted, links, lineBreaks, length}: what the text looks like, for the audit. */
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`).$type<SocialPostFeatures>(),
    source: text("source").notNull().$type<SocialSource>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_posts_project_external_uq").on(t.projectId, t.externalId),
    index("social_posts_project_published_idx").on(t.projectId, t.publishedAt),
    check("social_posts_source_ck", sql`${t.source} IN ('api', 'public_preview')`),
  ],
);

export const socialMetricsDaily = pgTable(
  "social_metrics_daily",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    followers: integer("followers"),
    reach: integer("reach"),
    views: integer("views"),
    profileViews: integer("profile_views"),
    /** Interactions that day (Instagram total_interactions). */
    engagement: integer("engagement"),
    source: text("source").notNull().$type<SocialSource>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("social_metrics_daily_uq").on(t.projectId, t.date, t.source),
    check("social_metrics_daily_source_ck", sql`${t.source} IN ('api', 'public_preview')`),
  ],
);

export const socialCompetitors = pgTable(
  "social_competitors",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().$type<SocialPlatform>(),
    /** Without the "@", lower case. */
    username: text("username").notNull(),
    /** The latest public snapshot, or null until one was taken. */
    snapshot: jsonb("snapshot").$type<SocialCompetitorSnapshot | null>(),
    /** ok | unsupported | not_found | error — why snapshot is (still) empty. */
    status: text("status").notNull().default("pending"),
    lastError: text("last_error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("social_competitors_uq").on(t.projectId, t.username)],
);

/**
 * Posts planned for a profile. Publishing in the owner's name needs a person's
 * approval, which the database enforces: a post cannot be scheduled, publishing,
 * published or failed without the approver recorded (social_posts_decided_ck).
 */
export const scheduledPosts = pgTable(
  "scheduled_posts",
  {
    id: id(),
    projectId: varchar("project_id", { length: 30 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    platform: text("platform").notNull().$type<SocialPlatform>(),
    status: text("status").notNull().default("draft").$type<ScheduledPostStatus>(),
    /** When to publish (UTC); null = as soon as approved. */
    publishAt: timestamp("publish_at", { withTimezone: true }),
    payload: jsonb("payload").notNull().$type<ScheduledPostPayload>(),
    requestedBy: text("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    /** Publishing attempts that reached the claim; bounded by the publisher. */
    attempts: integer("attempts").notNull().default(0),
    /** Set by the claim; a post stuck in publishing past a deadline is reported, never re-sent. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    resultExternalId: text("result_external_id"),
    resultPermalink: text("result_permalink"),
    /** Progress a retry may reuse (an Instagram container id), never the fact of publishing. */
    progress: jsonb("progress").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_posts_due_idx").on(t.status, t.publishAt),
    index("scheduled_posts_project_idx").on(t.projectId, t.publishAt),
    check(
      "scheduled_posts_status_ck",
      sql`${t.status} IN ('draft', 'awaiting_approval', 'rejected', 'scheduled', 'publishing', 'published', 'failed', 'canceled')`,
    ),
    check(
      "scheduled_posts_decided_ck",
      sql`${t.status} IN ('draft', 'awaiting_approval', 'rejected', 'canceled') OR (${t.decidedBy} IS NOT NULL AND ${t.decidedAt} IS NOT NULL)`,
    ),
  ],
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

/** The connectors that can apply fixes; see `projects.write_target`. */
export type WriteTarget = Extract<ConnectorKind, "WORDPRESS" | "CLOUDFLARE">;

/** What `detectPlatform` found for a project's site, stored in `projects.platform`. */
export type PlatformInfo = {
  cms:
    | "wordpress"
    | "shopify"
    | "wix"
    | "squarespace"
    | "webflow"
    | "joomla"
    | "drupal"
    | "magento"
    | "nextjs"
    | "nuxt"
    | "custom";
  cmsVersion: string | null;
  seoPlugin: "yoast" | "rankmath" | "aioseo" | "seopress" | null;
  /** "cloudflare", "arvancloud", "fastly", "cloudfront", "akamai", "vercel", "netlify", or null. */
  cdn: string | null;
  /** The Server header, as sent. */
  server: string | null;
  /** WordPress REST namespaces, when /wp-json/ answered; drives which plugin APIs are usable. */
  wpNamespaces?: string[];
  /** ISO timestamp. */
  detectedAt: string;
};

// ---------------------------------------------------------------- phase 2 types

export type KeywordDevice = "desktop" | "mobile";
export type PositionSource = "gsc" | "dataforseo";
export type IdeaSource = "autocomplete" | "gsc" | "dataforseo";
export type PageSpeedStrategy = "mobile" | "desktop";
export type ScheduleKind = "scan" | "rank" | "pagespeed" | "competitors" | "report" | "social_sync";
export type AlertKind =
  | "score_drop"
  | "new_critical"
  | "rank_drop"
  | "page_down"
  | "cwv_regression"
  | "index_drop"
  | "follower_drop"
  | "engagement_drop"
  | "token_expiring"
  | "publish_failed";
export type AlertChannel = "in_app" | "webhook" | "telegram";
export type IntegrationKind = "DATAFORSEO" | "PAGESPEED" | "TELEGRAM_ALERTS";
export type ReportKind = "audit" | "executive" | "keywords";
export type LocalizedText = { fa: string; en: string };
export type ReportBrand = { logo?: string; name?: string; color?: string };
export type PageLink = { u: string; a: string; nf?: 1 };
export type PageHeading = { l: number; t: string };
export type PageImage = { src: string; alt: string | null };

/**
 * A content document's WordPress publishing lifecycle. Content changes are
 * SENSITIVE: a request waits for a person with approval rights, and the
 * decision performs the write.
 */
export type ContentPublishState = {
  /** publishing: approved and being written right now (a claim, so two approvals cannot both write). */
  status: "pending" | "publishing" | "rejected" | "published" | "failed" | "rolled_back";
  /** draft: a new WordPress draft; update: replace the content of the post at the document's URL. */
  mode: "draft" | "update";
  postType: string;
  requestedBy: string;
  requestedAt: string;
  /** sha256 of title + body at request time; a later edit invalidates the request. */
  bodyHash: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
  post?: { id: number; restBase: string; link: string | null; status: string | null };
  /** update mode: what the post held before, for rollback. */
  previous?: { title: string; content: string };
  /** What was written, so rollback can tell whether someone edited it since. */
  written?: { title: string; content: string };
  publishedAt?: string;
  error?: string;
};

export type HeadingSummary = {
  counts: { h1: number; h2: number; h3: number; h4: number; h5: number; h6: number };
  h2: string[];
};

/** Google's CWV bucket for a 75th-percentile value. */
export type CwvCategory = "FAST" | "AVERAGE" | "SLOW";
export type CruxMetric = { p75: number; category: CwvCategory | null };
export type CruxFieldData = {
  /** "url" when Google has data for this page, "origin" when only for the whole site. */
  scope: "url" | "origin";
  overall: CwvCategory | null;
  lcpMs?: CruxMetric;
  /** Unitless (CrUX reports it ×100; stored divided back). */
  cls?: CruxMetric;
  inpMs?: CruxMetric;
  fcpMs?: CruxMetric;
  ttfbMs?: CruxMetric;
};
export type PageSpeedOpportunity = {
  id: string;
  title: string;
  /** Estimated saving, from Lighthouse. */
  savingsMs: number | null;
  savingsBytes: number | null;
  score: number | null;
};
export type NotificationDelivery = {
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  error?: string | null;
  at: string;
};

export type Keyword = typeof keywords.$inferSelect;
export type KeywordPosition = typeof keywordPositions.$inferSelect;
export type KeywordIdea = typeof keywordIdeas.$inferSelect;
export type Competitor = typeof competitors.$inferSelect;
export type CompetitorSnapshot = typeof competitorSnapshots.$inferSelect;
export type PageSpeedRow = typeof pageSpeed.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type AlertRule = typeof alertRules.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type OrgIntegration = typeof orgIntegrations.$inferSelect;
export type ContentDocument = typeof contentDocuments.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type PageDetails = typeof pageDetails.$inferSelect;

// ---------------------------------------------------------------- 0009 types

export type ProjectKind = "WEBSITE" | "INSTAGRAM" | "TELEGRAM";
export type SocialPlatform = Exclude<ProjectKind, "WEBSITE">;
export type SocialSource = "api" | "public_preview";
export type SocialPostType = "image" | "video" | "reel" | "carousel" | "text" | "photo" | "album" | "other";
export type SocialProfile = {
  pictureUrl?: string | null;
  /** Instagram: BUSINESS | MEDIA_CREATOR. */
  accountType?: string | null;
  /** Telegram: the bot that manages the channel. */
  botId?: number;
  botUsername?: string | null;
  /** Telegram: the bot's administrator rights in the channel, as last checked. */
  rights?: Record<string, boolean>;
  pinnedMessageId?: number | null;
  pinnedText?: string | null;
  /** Telegram: how channel posts reach the panel. */
  updates?: { mode: "webhook" | "polling"; offset?: number; setAt?: string; error?: string | null };
  /** Telegram: whether t.me/s/<username> answers (public channels only). */
  publicPreview?: boolean;
  /** Instagram: Business Discovery works with this token (competitors). */
  businessDiscovery?: boolean | null;
};
export type SocialSettings = {
  /** Words the profile should be found for (search inside Instagram / Telegram). */
  keywords?: string[];
  /** The call to action the audit looks for and suggests, e.g. "Order via DM". */
  cta?: string | null;
  /** The link the audit suggests adding (site, shop). */
  link?: string | null;
  /** IANA zone for best-time analytics and the calendar; default Asia/Tehran. */
  timezone?: string | null;
};
export type SocialPostMetrics = {
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  reach?: number;
  views?: number;
  interactions?: number;
};
export type SocialPostFeatures = { length?: number; formatted?: boolean; links?: number; lineBreaks?: number };
export type SocialCompetitorSnapshot = {
  source: "business_discovery" | "public_preview";
  name: string | null;
  bio: string | null;
  followers: number | null;
  mediaCount: number | null;
  /** Recent posts seen: {at, views?, likes?, comments?}. */
  recent: Array<{ at: string | null; views?: number | null; likes?: number | null; comments?: number | null }>;
  postsPerWeek: number | null;
  avgViews: number | null;
  avgInteractions: number | null;
};
export type ScheduledPostStatus =
  | "draft"
  | "awaiting_approval"
  | "rejected"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "canceled";
export type ScheduledMedia = { url: string; type: "image" | "video"; altText?: string | null };
export type ScheduledPostPayload =
  | {
      op: "post";
      /** Instagram: image | carousel | reel. Telegram: text | photo | album | video. */
      format: "image" | "carousel" | "reel" | "text" | "photo" | "album" | "video";
      /** Instagram caption, or Telegram text/caption (Telegram HTML). */
      text: string;
      media: ScheduledMedia[];
      /** Telegram: pin after sending. */
      pin?: boolean;
      /** Telegram: send silently. */
      silent?: boolean;
      /** Instagram reels: also show in the grid. */
      shareToFeed?: boolean;
    }
  | { op: "edit"; messageId: number; text: string; target: "text" | "caption" }
  | { op: "pin"; messageId: number; silent?: boolean };

export type SocialAccount = typeof socialAccounts.$inferSelect;
export type SocialPost = typeof socialPosts.$inferSelect;
export type SocialMetricsDay = typeof socialMetricsDaily.$inferSelect;
export type SocialCompetitor = typeof socialCompetitors.$inferSelect;
export type ScheduledPost = typeof scheduledPosts.$inferSelect;
