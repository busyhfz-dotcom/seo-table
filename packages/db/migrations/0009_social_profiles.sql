-- 0009: Instagram pages and Telegram channels as projects of their own kind:
-- the connected account, its posts and daily metrics, public competitor
-- snapshots, and planned posts whose publishing needs a person's approval.
-- New fix actions need no change to seo_action_min_risk (0004): an action it
-- does not list is SENSITIVE, which is what every social action is.
ALTER TYPE "public"."connector_kind" ADD VALUE 'TELEGRAM';--> statement-breakpoint
ALTER TYPE "public"."fix_action" ADD VALUE 'SOCIAL_PROFILE_NAME';--> statement-breakpoint
ALTER TYPE "public"."fix_action" ADD VALUE 'SOCIAL_BIO';--> statement-breakpoint
ALTER TYPE "public"."fix_action" ADD VALUE 'SOCIAL_TITLE';--> statement-breakpoint
ALTER TYPE "public"."fix_action" ADD VALUE 'SOCIAL_DESCRIPTION';--> statement-breakpoint
ALTER TYPE "public"."fix_action" ADD VALUE 'SOCIAL_POST';--> statement-breakpoint
CREATE TABLE "scheduled_posts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"platform" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"result_external_id" text,
	"result_permalink" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_posts_status_ck" CHECK ("scheduled_posts"."status" IN ('draft', 'awaiting_approval', 'rejected', 'scheduled', 'publishing', 'published', 'failed', 'canceled')),
	CONSTRAINT "scheduled_posts_decided_ck" CHECK ("scheduled_posts"."status" IN ('draft', 'awaiting_approval', 'rejected', 'canceled') OR ("scheduled_posts"."decided_by" IS NOT NULL AND "scheduled_posts"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"platform" text NOT NULL,
	"external_id" text,
	"username" text,
	"display_name" text,
	"bio" text,
	"website" text,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"followers" integer,
	"following" integer,
	"media_count" integer,
	"secret_cipher" text,
	"secret_iv" text,
	"secret_tag" text,
	"token_expires_at" timestamp with time zone,
	"token_refreshed_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "connector_status" DEFAULT 'NOT_CONNECTED' NOT NULL,
	"last_error" text,
	"last_sync_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"connected_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_accounts_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "social_accounts_platform_ck" CHECK ("social_accounts"."platform" IN ('INSTAGRAM', 'TELEGRAM'))
);
--> statement-breakpoint
CREATE TABLE "social_competitors" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"platform" text NOT NULL,
	"username" text NOT NULL,
	"snapshot" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_metrics_daily" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"date" date NOT NULL,
	"followers" integer,
	"reach" integer,
	"views" integer,
	"profile_views" integer,
	"engagement" integer,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_metrics_daily_source_ck" CHECK ("social_metrics_daily"."source" IN ('api', 'public_preview'))
);
--> statement-breakpoint
CREATE TABLE "social_posts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"permalink" text,
	"type" text NOT NULL,
	"caption" text,
	"media_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"alt_texts" text[],
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics_at" timestamp with time zone,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_posts_source_ck" CHECK ("social_posts"."source" IN ('api', 'public_preview'))
);
--> statement-breakpoint
ALTER TABLE "alert_rules" DROP CONSTRAINT "alert_rules_kind_ck";--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_kind_ck";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" text DEFAULT 'WEBSITE' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_competitors" ADD CONSTRAINT "social_competitors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_metrics_daily" ADD CONSTRAINT "social_metrics_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_posts_due_idx" ON "scheduled_posts" USING btree ("status","publish_at");--> statement-breakpoint
CREATE INDEX "scheduled_posts_project_idx" ON "scheduled_posts" USING btree ("project_id","publish_at");--> statement-breakpoint
CREATE INDEX "social_accounts_external_idx" ON "social_accounts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_competitors_uq" ON "social_competitors" USING btree ("project_id","username");--> statement-breakpoint
CREATE UNIQUE INDEX "social_metrics_daily_uq" ON "social_metrics_daily" USING btree ("project_id","date","source");--> statement-breakpoint
CREATE UNIQUE INDEX "social_posts_project_external_uq" ON "social_posts" USING btree ("project_id","external_id");--> statement-breakpoint
CREATE INDEX "social_posts_project_published_idx" ON "social_posts" USING btree ("project_id","published_at");--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_kind_ck" CHECK ("alert_rules"."kind" IN ('score_drop', 'new_critical', 'rank_drop', 'page_down', 'cwv_regression', 'index_drop', 'follower_drop', 'engagement_drop', 'token_expiring', 'publish_failed'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_kind_ck" CHECK ("projects"."kind" IN ('WEBSITE', 'INSTAGRAM', 'TELEGRAM'));--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_kind_ck" CHECK ("schedules"."kind" IN ('scan', 'rank', 'pagespeed', 'competitors', 'report', 'social_sync'));--> statement-breakpoint
-- A project's kind decides which tables and jobs apply to it; turning a
-- website into a Telegram channel would leave both halves inconsistent.
CREATE OR REPLACE FUNCTION "seo_project_kind_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'project %: kind cannot change (% -> %)', OLD."id", OLD."kind", NEW."kind"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "projects_kind_immutable" ON "projects";
--> statement-breakpoint
CREATE TRIGGER "projects_kind_immutable"
  BEFORE UPDATE OF "kind" ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "seo_project_kind_immutable"();
--> statement-breakpoint
-- Defaults per kind (replaces 0007's version). A social project must never get
-- a website scan: its base_url is instagram.com or t.me, which is not ours to
-- crawl. It gets a daily sync and the social alerts instead.
CREATE OR REPLACE FUNCTION "seo_project_defaults"() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IN ('INSTAGRAM', 'TELEGRAM') THEN
    INSERT INTO "schedules" ("id", "project_id", "kind", "cron", "timezone", "enabled")
    VALUES ('s' || left(md5(NEW."id" || ':social_sync'), 29), NEW."id", 'social_sync', '0 2 * * *', 'UTC', true)
    ON CONFLICT DO NOTHING;

    INSERT INTO "alert_rules" ("id", "project_id", "kind", "threshold", "channels", "enabled")
    VALUES
      ('a' || left(md5(NEW."id" || ':follower_drop'), 29),   NEW."id", 'follower_drop',   5,    '{in_app}', true),
      ('a' || left(md5(NEW."id" || ':engagement_drop'), 29), NEW."id", 'engagement_drop', 30,   '{in_app}', true),
      ('a' || left(md5(NEW."id" || ':token_expiring'), 29),  NEW."id", 'token_expiring',  7,    '{in_app}', true),
      ('a' || left(md5(NEW."id" || ':publish_failed'), 29),  NEW."id", 'publish_failed',  NULL, '{in_app}', true)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO "schedules" ("id", "project_id", "kind", "cron", "timezone", "enabled")
  VALUES
    ('s' || left(md5(NEW."id" || ':scan'), 29),        NEW."id", 'scan',        '0 3 * * 1', 'UTC', true),
    ('s' || left(md5(NEW."id" || ':rank'), 29),        NEW."id", 'rank',        '0 4 * * *', 'UTC', true),
    ('s' || left(md5(NEW."id" || ':pagespeed'), 29),   NEW."id", 'pagespeed',   '0 5 * * 3', 'UTC', true),
    ('s' || left(md5(NEW."id" || ':competitors'), 29), NEW."id", 'competitors', '0 6 * * 0', 'UTC', true),
    ('s' || left(md5(NEW."id" || ':report'), 29),      NEW."id", 'report',      '0 7 1 * *', 'UTC', false)
  ON CONFLICT DO NOTHING;

  INSERT INTO "alert_rules" ("id", "project_id", "kind", "threshold", "channels", "enabled")
  VALUES
    ('a' || left(md5(NEW."id" || ':score_drop'), 29),     NEW."id", 'score_drop',     5,    '{in_app}', true),
    ('a' || left(md5(NEW."id" || ':new_critical'), 29),   NEW."id", 'new_critical',   NULL, '{in_app}', true),
    ('a' || left(md5(NEW."id" || ':rank_drop'), 29),      NEW."id", 'rank_drop',      5,    '{in_app}', true),
    ('a' || left(md5(NEW."id" || ':page_down'), 29),      NEW."id", 'page_down',      NULL, '{in_app}', true),
    ('a' || left(md5(NEW."id" || ':cwv_regression'), 29), NEW."id", 'cwv_regression', 10,   '{in_app}', true),
    ('a' || left(md5(NEW."id" || ':index_drop'), 29),     NEW."id", 'index_drop',     20,   '{in_app}', true)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
