CREATE TYPE "public"."actor_type" AS ENUM('USER', 'AGENT', 'SYSTEM', 'API_KEY');--> statement-breakpoint
CREATE TYPE "public"."connector_kind" AS ENUM('WORDPRESS', 'SEARCH_CONSOLE', 'GA4', 'INSTAGRAM', 'YOUTUBE');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('NOT_CONNECTED', 'CONNECTED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."decision" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."fix_action" AS ENUM('TITLE_REWRITE', 'META_REWRITE', 'H1_FIX', 'ALT_TEXT', 'CANONICAL_FIX', 'ROBOTS_FIX', 'SITEMAP_ADD', 'INTERNAL_LINK', 'REDIRECT', 'URL_CHANGE', 'PAGE_MERGE');--> statement-breakpoint
CREATE TYPE "public"."fix_status" AS ENUM('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLYING', 'APPLIED', 'FAILED', 'ROLLED_BACK');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('OPEN', 'FIXED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."occurrence_kind" AS ENUM('DETECTED', 'PERSISTED', 'RESOLVED', 'REGRESSED');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'SENSITIVE', 'RESTRICTED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'DEAD_LETTER');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('MANUAL', 'SCHEDULE', 'API', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('CRITICAL', 'SERIOUS', 'WARNING', 'INFO');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"org_id" varchar(30) NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"fix_proposal_id" varchar(30) NOT NULL,
	"decision" "decision" DEFAULT 'PENDING' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approvals_fix_proposal_id_unique" UNIQUE("fix_proposal_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"org_id" varchar(30) NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"status" "run_status" DEFAULT 'QUEUED' NOT NULL,
	"trigger" "run_trigger" DEFAULT 'MANUAL' NOT NULL,
	"idempotency_key" text NOT NULL,
	"job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"pages_crawled" integer DEFAULT 0 NOT NULL,
	"pages_total" integer,
	"score" integer,
	"score_breakdown" jsonb,
	"error" text,
	"error_code" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_by_id" text
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"kind" "connector_kind" NOT NULL,
	"status" "connector_status" DEFAULT 'NOT_CONNECTED' NOT NULL,
	"secret_cipher" text,
	"secret_iv" text,
	"secret_tag" text,
	"config" jsonb,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_opportunities" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"query" text NOT NULL,
	"url" text,
	"impressions" integer NOT NULL,
	"clicks" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	"gap" "severity" NOT NULL,
	"suggested_action" text NOT NULL,
	"source" text DEFAULT 'SEARCH_CONSOLE' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fix_executions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"fix_proposal_id" varchar(30) NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" "fix_status" NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb,
	"results" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fix_proposals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"issue_id" varchar(30),
	"rule_id" text NOT NULL,
	"action" "fix_action" NOT NULL,
	"risk" "risk_level" NOT NULL,
	"status" "fix_status" DEFAULT 'DRAFT' NOT NULL,
	"title" text NOT NULL,
	"rationale" text,
	"target_count" integer DEFAULT 0 NOT NULL,
	"changes" jsonb NOT NULL,
	"dry_run" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_occurrences" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"issue_id" varchar(30) NOT NULL,
	"audit_run_id" varchar(30) NOT NULL,
	"page_snapshot_id" varchar(30),
	"url" text NOT NULL,
	"kind" "occurrence_kind" NOT NULL,
	"severity" "severity" NOT NULL,
	"evidence" jsonb,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(30) NOT NULL,
	"org_id" varchar(30) NOT NULL,
	"role" "role" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "page_snapshots" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"audit_run_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status_code" integer NOT NULL,
	"response_ms" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"body_bytes" integer DEFAULT 0 NOT NULL,
	"title" text,
	"title_length" integer DEFAULT 0 NOT NULL,
	"meta_description" text,
	"meta_description_length" integer DEFAULT 0 NOT NULL,
	"h1s" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"canonical" text,
	"robots_meta" text,
	"x_robots_tag" text,
	"indexable" boolean DEFAULT true NOT NULL,
	"noindex_reason" text,
	"lang" text,
	"word_count" integer DEFAULT 0 NOT NULL,
	"images_total" integer DEFAULT 0 NOT NULL,
	"images_missing_alt" integer DEFAULT 0 NOT NULL,
	"internal_links_out" integer DEFAULT 0 NOT NULL,
	"internal_links_in" integer DEFAULT 0 NOT NULL,
	"external_links_out" integer DEFAULT 0 NOT NULL,
	"in_sitemap" boolean DEFAULT false NOT NULL,
	"redirect_chain" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"org_id" varchar(30) NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"locale" text DEFAULT 'fa' NOT NULL,
	"page_cap" integer DEFAULT 2000 NOT NULL,
	"crawl_rate" integer DEFAULT 8 NOT NULL,
	"score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_issues" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"rule_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" "severity" NOT NULL,
	"status" "issue_status" DEFAULT 'OPEN' NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_run_id" text,
	"last_seen_run_id" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" varchar(30) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_fix_proposal_id_fix_proposals_id_fk" FOREIGN KEY ("fix_proposal_id") REFERENCES "public"."fix_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_opportunities" ADD CONSTRAINT "content_opportunities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_executions" ADD CONSTRAINT "fix_executions_fix_proposal_id_fix_proposals_id_fk" FOREIGN KEY ("fix_proposal_id") REFERENCES "public"."fix_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_proposals" ADD CONSTRAINT "fix_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_occurrences" ADD CONSTRAINT "issue_occurrences_issue_id_seo_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."seo_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_occurrences" ADD CONSTRAINT "issue_occurrences_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD CONSTRAINT "seo_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "approvals_decision_idx" ON "approvals" USING btree ("decision");--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_runs_project_idem_uq" ON "audit_runs" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "audit_runs_project_queued_idx" ON "audit_runs" USING btree ("project_id","queued_at");--> statement-breakpoint
CREATE INDEX "audit_runs_status_idx" ON "audit_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_project_kind_uq" ON "connectors" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "content_opps_uq" ON "content_opportunities" USING btree ("project_id","query","period_start");--> statement-breakpoint
CREATE INDEX "content_opps_project_idx" ON "content_opportunities" USING btree ("project_id","impressions");--> statement-breakpoint
CREATE INDEX "fix_executions_proposal_idx" ON "fix_executions" USING btree ("fix_proposal_id");--> statement-breakpoint
CREATE INDEX "fix_proposals_project_status_idx" ON "fix_proposals" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_occurrences_unique" ON "issue_occurrences" USING btree ("issue_id","audit_run_id","url","kind");--> statement-breakpoint
CREATE INDEX "issue_occurrences_issue_idx" ON "issue_occurrences" USING btree ("issue_id","observed_at");--> statement-breakpoint
CREATE INDEX "issue_occurrences_run_idx" ON "issue_occurrences" USING btree ("audit_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_uq" ON "memberships" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "memberships_org_idx" ON "memberships" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_snapshots_run_url_uq" ON "page_snapshots" USING btree ("audit_run_id","normalized_url");--> statement-breakpoint
CREATE INDEX "page_snapshots_project_url_idx" ON "page_snapshots" USING btree ("project_id","normalized_url");--> statement-breakpoint
CREATE INDEX "page_snapshots_hash_idx" ON "page_snapshots" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_issues_project_fp_uq" ON "seo_issues" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "seo_issues_project_status_idx" ON "seo_issues" USING btree ("project_id","status","severity");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");