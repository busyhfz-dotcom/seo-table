-- 0008: content editor publishing, report branding, the per-page crawl details
-- (internal link graph, headings, JSON-LD, images, Last-Modified) that internal
-- linking, schema markup and the sitemap generator read, and three fix actions
-- for whole-document edge overrides (JSON-LD, robots.txt, sitemap.xml).
ALTER TYPE "public"."fix_action" ADD VALUE 'SCHEMA_MARKUP';--> statement-breakpoint
ALTER TYPE "public"."fix_action" ADD VALUE 'ROBOTS_TXT';--> statement-breakpoint
ALTER TYPE "public"."fix_action" ADD VALUE 'SITEMAP_XML';--> statement-breakpoint
CREATE TABLE "page_details" (
	"snapshot_id" varchar(30) PRIMARY KEY NOT NULL,
	"audit_run_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"headings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"json_ld" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_modified" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "content_documents" ADD COLUMN "meta_title" text;--> statement-breakpoint
ALTER TABLE "content_documents" ADD COLUMN "meta_description" text;--> statement-breakpoint
ALTER TABLE "content_documents" ADD COLUMN "publish" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "report_brand" jsonb;--> statement-breakpoint
ALTER TABLE "page_details" ADD CONSTRAINT "page_details_snapshot_id_page_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."page_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_details" ADD CONSTRAINT "page_details_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_details" ADD CONSTRAINT "page_details_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_details_run_idx" ON "page_details" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX "page_details_project_idx" ON "page_details" USING btree ("project_id");