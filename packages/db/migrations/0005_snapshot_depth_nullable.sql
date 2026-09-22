ALTER TABLE "page_snapshots" ALTER COLUMN "depth" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "page_snapshots" ALTER COLUMN "depth" DROP NOT NULL;