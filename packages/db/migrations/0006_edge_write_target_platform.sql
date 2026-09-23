ALTER TYPE "public"."connector_kind" ADD VALUE 'CLOUDFLARE';--> statement-breakpoint
ALTER TABLE "fix_executions" ADD COLUMN "connector_kind" "connector_kind";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "write_target" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "platform" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_write_target_ck" CHECK ("projects"."write_target" IS NULL OR "projects"."write_target" IN ('WORDPRESS', 'CLOUDFLARE'));