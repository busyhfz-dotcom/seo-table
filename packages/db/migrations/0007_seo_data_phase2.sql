CREATE TABLE "alert_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"kind" text NOT NULL,
	"threshold" double precision,
	"channels" text[] DEFAULT '{in_app}'::text[] NOT NULL,
	"webhook_url" text,
	"webhook_secret_cipher" text,
	"webhook_secret_iv" text,
	"webhook_secret_tag" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_kind_ck" CHECK ("alert_rules"."kind" IN ('score_drop', 'new_critical', 'rank_drop', 'page_down', 'cwv_regression', 'index_drop')),
	CONSTRAINT "alert_rules_channels_ck" CHECK ("alert_rules"."channels" <@ ARRAY['in_app', 'webhook', 'telegram']::text[])
);
--> statement-breakpoint
CREATE TABLE "competitor_snapshots" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"competitor_id" varchar(30) NOT NULL,
	"url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_code" integer NOT NULL,
	"title" text,
	"meta_description" text,
	"h1" text[] DEFAULT '{}'::text[] NOT NULL,
	"headings" jsonb,
	"word_count" integer DEFAULT 0 NOT NULL,
	"schema_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"internal_links" integer DEFAULT 0 NOT NULL,
	"external_links" integer DEFAULT 0 NOT NULL,
	"lcp_ms" integer,
	"cls" double precision
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"is_self" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_documents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"title" text NOT NULL,
	"target_keyword" text,
	"locale" text DEFAULT 'fa' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"score" integer,
	"analysis" jsonb,
	"url" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keyword_ideas" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"seed" text NOT NULL,
	"idea" text NOT NULL,
	"source" text NOT NULL,
	"locale" text DEFAULT 'fa' NOT NULL,
	"country" varchar(2) DEFAULT 'IR' NOT NULL,
	"volume" integer,
	"difficulty" integer,
	"cpc" double precision,
	"impressions" integer,
	"clicks" integer,
	"position" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_ideas_source_ck" CHECK ("keyword_ideas"."source" IN ('autocomplete', 'gsc', 'dataforseo'))
);
--> statement-breakpoint
CREATE TABLE "keyword_positions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"keyword_id" varchar(30) NOT NULL,
	"date" date NOT NULL,
	"source" text NOT NULL,
	"position" double precision,
	"url" text,
	"clicks" integer,
	"impressions" integer,
	"ctr" double precision,
	"serp_features" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_positions_source_ck" CHECK ("keyword_positions"."source" IN ('gsc', 'dataforseo'))
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"phrase" text NOT NULL,
	"locale" text DEFAULT 'fa' NOT NULL,
	"country" varchar(2) DEFAULT 'IR' NOT NULL,
	"device" text,
	"target_url" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "keywords_device_ck" CHECK ("keywords"."device" IS NULL OR "keywords"."device" IN ('desktop', 'mobile')),
	CONSTRAINT "keywords_country_ck" CHECK ("keywords"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"org_id" varchar(30) NOT NULL,
	"project_id" varchar(30),
	"alert_rule_id" varchar(30),
	"kind" text NOT NULL,
	"severity" "severity" NOT NULL,
	"title" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"link" text,
	"data" jsonb,
	"dedupe_key" text,
	"deliveries" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "org_integrations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"org_id" varchar(30) NOT NULL,
	"kind" text NOT NULL,
	"secret_cipher" text,
	"secret_iv" text,
	"secret_tag" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "connector_status" DEFAULT 'NOT_CONNECTED' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_integrations_kind_ck" CHECK ("org_integrations"."kind" IN ('DATAFORSEO', 'PAGESPEED', 'TELEGRAM_ALERTS'))
);
--> statement-breakpoint
CREATE TABLE "page_speed" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"url" text NOT NULL,
	"strategy" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"performance_score" integer,
	"lcp_ms" integer,
	"cls" double precision,
	"inp_ms" integer,
	"ttfb_ms" integer,
	"fcp_ms" integer,
	"tbt_ms" integer,
	"field_data" jsonb,
	"opportunities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "page_speed_strategy_ck" CHECK ("page_speed"."strategy" IN ('mobile', 'desktop'))
);
--> statement-breakpoint
CREATE TABLE "provider_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"org_id" varchar(30) NOT NULL,
	"project_id" varchar(30),
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"cost" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"kind" text NOT NULL,
	"run_id" varchar(30),
	"file_key" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"brand" jsonb,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_kind_ck" CHECK ("reports"."kind" IN ('audit', 'executive', 'keywords')),
	CONSTRAINT "reports_size_ck" CHECK (octet_length("reports"."content") <= 10485760 AND "reports"."bytes" = octet_length("reports"."content"))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"kind" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_kind_ck" CHECK ("schedules"."kind" IN ('scan', 'rank', 'pagespeed', 'competitors', 'report'))
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_snapshots" ADD CONSTRAINT "competitor_snapshots_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_documents" ADD CONSTRAINT "content_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_ideas" ADD CONSTRAINT "keyword_ideas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_positions" ADD CONSTRAINT "keyword_positions_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_rule_id_alert_rules_id_fk" FOREIGN KEY ("alert_rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_integrations" ADD CONSTRAINT "org_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_speed" ADD CONSTRAINT "page_speed_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_audit_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."audit_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_rules_project_idx" ON "alert_rules" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "competitor_snapshots_idx" ON "competitor_snapshots" USING btree ("competitor_id","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_project_domain_uq" ON "competitors" USING btree ("project_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_one_self_uq" ON "competitors" USING btree ("project_id") WHERE "competitors"."is_self";--> statement-breakpoint
CREATE INDEX "content_documents_project_idx" ON "content_documents" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_ideas_uq" ON "keyword_ideas" USING btree ("project_id","seed","idea","source","locale","country");--> statement-breakpoint
CREATE INDEX "keyword_ideas_lookup_idx" ON "keyword_ideas" USING btree ("project_id","source","seed","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_positions_uq" ON "keyword_positions" USING btree ("keyword_id","date","source");--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_project_phrase_uq" ON "keywords" USING btree ("project_id",lower("phrase"),"country",coalesce("device", ''));--> statement-breakpoint
CREATE INDEX "keywords_project_idx" ON "keywords" USING btree ("project_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_org_idx" ON "notifications" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("org_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_integrations_org_kind_uq" ON "org_integrations" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "page_speed_project_url_idx" ON "page_speed" USING btree ("project_id","url","strategy","fetched_at");--> statement-breakpoint
CREATE INDEX "provider_usage_org_idx" ON "provider_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_project_idx" ON "reports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_project_kind_uq" ON "schedules" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("enabled","next_run_at");
--> statement-breakpoint
-- Every project gets its default schedules and alert rules the moment it exists,
-- whichever code path created it (API, seed, owner bootstrap). A trigger rather
-- than application code, so no path can forget; the rows are ordinary afterwards
-- and the user may change or delete them. next_run_at stays NULL: the worker's
-- scheduler computes it from the cron (with a real cron library) on its next tick.
CREATE OR REPLACE FUNCTION "seo_project_defaults"() RETURNS trigger AS $$
BEGIN
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
--> statement-breakpoint
DROP TRIGGER IF EXISTS "projects_defaults" ON "projects";
--> statement-breakpoint
CREATE TRIGGER "projects_defaults"
  AFTER INSERT ON "projects"
  FOR EACH ROW EXECUTE FUNCTION "seo_project_defaults"();
--> statement-breakpoint
-- Existing projects get the same defaults once.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT "id" FROM "projects" LOOP
    INSERT INTO "schedules" ("id", "project_id", "kind", "cron", "timezone", "enabled")
    VALUES
      ('s' || left(md5(p."id" || ':scan'), 29),        p."id", 'scan',        '0 3 * * 1', 'UTC', true),
      ('s' || left(md5(p."id" || ':rank'), 29),        p."id", 'rank',        '0 4 * * *', 'UTC', true),
      ('s' || left(md5(p."id" || ':pagespeed'), 29),   p."id", 'pagespeed',   '0 5 * * 3', 'UTC', true),
      ('s' || left(md5(p."id" || ':competitors'), 29), p."id", 'competitors', '0 6 * * 0', 'UTC', true),
      ('s' || left(md5(p."id" || ':report'), 29),      p."id", 'report',      '0 7 1 * *', 'UTC', false)
    ON CONFLICT DO NOTHING;
    INSERT INTO "alert_rules" ("id", "project_id", "kind", "threshold", "channels", "enabled")
    VALUES
      ('a' || left(md5(p."id" || ':score_drop'), 29),     p."id", 'score_drop',     5,    '{in_app}', true),
      ('a' || left(md5(p."id" || ':new_critical'), 29),   p."id", 'new_critical',   NULL, '{in_app}', true),
      ('a' || left(md5(p."id" || ':rank_drop'), 29),      p."id", 'rank_drop',      5,    '{in_app}', true),
      ('a' || left(md5(p."id" || ':page_down'), 29),      p."id", 'page_down',      NULL, '{in_app}', true),
      ('a' || left(md5(p."id" || ':cwv_regression'), 29), p."id", 'cwv_regression', 10,   '{in_app}', true),
      ('a' || left(md5(p."id" || ':index_drop'), 29),     p."id", 'index_drop',     20,   '{in_app}', true)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
