-- v0.4 hardening.
--
-- 1. audit_runs.heartbeat_at: the reaper judges a run by its last sign of life,
--    not by when it was queued, so a long healthy crawl is never reaped.
-- 2. sessions.org_id (+ memberships.created_at to order a user's organizations):
--    a session acts in one organization, chosen explicitly.
-- 3. The approval trigger can no longer be sidestepped by relabelling a fix.
-- 4. TRUNCATE is refused on the append-only ledgers.
-- 5. Foreign keys for fix_proposals.issue_id and issue_occurrences.page_snapshot_id.

ALTER TABLE "audit_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "org_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_org_idx" ON "sessions" USING btree ("org_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3) Approval trigger.
--
-- 0001 trusted the row's own risk column, so `UPDATE fix_proposals SET
-- risk = 'LOW'` followed by `SET status = 'APPLIED'` walked straight past it.
-- The floor below mirrors ACTION_RISK in packages/core/src/policy.ts; an action
-- missing here defaults to SENSITIVE so a new action fails closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "seo_action_min_risk"(a "fix_action") RETURNS "risk_level" AS $$
  SELECT (CASE a
    WHEN 'ALT_TEXT' THEN 'LOW'
    WHEN 'SITEMAP_ADD' THEN 'LOW'
    WHEN 'META_REWRITE' THEN 'LOW'
    WHEN 'REDIRECT' THEN 'RESTRICTED'
    WHEN 'URL_CHANGE' THEN 'RESTRICTED'
    WHEN 'PAGE_MERGE' THEN 'RESTRICTED'
    ELSE 'SENSITIVE'
  END)::"risk_level";
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "seo_require_approval"() RETURNS trigger AS $$
DECLARE
  needs_approval boolean;
  has_approval boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- What was approved is the action at the risk it was approved at; neither
    -- may be edited afterwards.
    IF NEW."action" IS DISTINCT FROM OLD."action" THEN
      RAISE EXCEPTION 'fix proposal %: action cannot change (% -> %)', NEW."id", OLD."action", NEW."action"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."risk" < OLD."risk" THEN
      RAISE EXCEPTION 'fix proposal %: risk cannot be lowered (% -> %)', NEW."id", OLD."risk", NEW."risk"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- A mislabelled risk is raised to the action's floor rather than believed.
  NEW."risk" := GREATEST(NEW."risk", "seo_action_min_risk"(NEW."action"));

  needs_approval := NEW."risk" IN ('SENSITIVE', 'RESTRICTED')
                 OR NEW."action" IN ('REDIRECT', 'URL_CHANGE', 'PAGE_MERGE');

  -- Checked on the transition into execution. Re-checking every later update
  -- would break an ON DELETE SET NULL of issue_id during a purge, when the
  -- approval row may already have been removed by the same cascade.
  IF needs_approval AND NEW."status" IN ('APPLYING', 'APPLIED')
     AND (TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    SELECT EXISTS (
      SELECT 1 FROM "approvals" a
      WHERE a."fix_proposal_id" = NEW."id" AND a."decision" = 'APPROVED'
    ) INTO has_approval;

    IF NOT has_approval THEN
      RAISE EXCEPTION
        'fix proposal % (% / %) requires an approved approval before execution',
        NEW."id", NEW."action", NEW."risk"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Existing rows get the same floor the trigger now applies to new ones.
UPDATE "fix_proposals" SET "risk" = "seo_action_min_risk"("action")
  WHERE "risk" < "seo_action_min_risk"("action");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4) TRUNCATE bypasses row triggers, so the ledgers need a statement trigger.
-- seo_reject_mutation (0003) only opens its purge door for DELETE.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "issue_occurrences_no_truncate" ON "issue_occurrences";--> statement-breakpoint
CREATE TRIGGER "issue_occurrences_no_truncate"
  BEFORE TRUNCATE ON "issue_occurrences"
  FOR EACH STATEMENT EXECUTE FUNCTION "seo_reject_mutation"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_no_truncate" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate"
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "seo_reject_mutation"();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5) Foreign keys.
--
-- A proposal outlives the issue it came from (SET NULL). Dangling ids from
-- before this migration are cleared first; the trigger above allows that update.
-- ---------------------------------------------------------------------------
UPDATE "fix_proposals" p SET "issue_id" = NULL
  WHERE p."issue_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "seo_issues" i WHERE i."id" = p."issue_id");--> statement-breakpoint
ALTER TABLE "fix_proposals" ADD CONSTRAINT "fix_proposals_issue_id_seo_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."seo_issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- An occurrence cannot be nulled out (UPDATE is refused), so this is NO ACTION:
-- a purge deletes snapshots and occurrences in one statement and passes the
-- end-of-statement check. Old rows cannot be repaired either, so the constraint
-- is validated only when no dangling reference exists; new rows are always checked.
ALTER TABLE "issue_occurrences" ADD CONSTRAINT "issue_occurrences_page_snapshot_id_page_snapshots_id_fk" FOREIGN KEY ("page_snapshot_id") REFERENCES "public"."page_snapshots"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "issue_occurrences" o
    WHERE o."page_snapshot_id" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "page_snapshots" s WHERE s."id" = o."page_snapshot_id")
  ) THEN
    ALTER TABLE "issue_occurrences" VALIDATE CONSTRAINT "issue_occurrences_page_snapshot_id_page_snapshots_id_fk";
  END IF;
END $$;
