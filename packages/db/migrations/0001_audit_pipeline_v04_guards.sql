-- v0.4 guards: the invariants the application is not allowed to break.
--
-- 1. At most one active audit run per project.
-- 2. issue_occurrences and audit_log are append-only.
--
-- Both are enforced here so that a bug, a stray psql session, or a second
-- deployed instance cannot violate them.

-- ---------------------------------------------------------------------------
-- 1) Single active run per project.
--
-- A partial unique index turns the check-then-insert race into a unique
-- violation the API can translate into HTTP 409. Note this deliberately does
-- NOT include CANCELED/FAILED/SUCCEEDED, so history is unconstrained.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "audit_runs_one_active_per_project"
  ON "audit_runs" ("project_id")
  WHERE "status" IN ('QUEUED', 'RUNNING');

-- Queue lookups by job id must be unique, but many rows legitimately have NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "audit_runs_job_id_uq"
  ON "audit_runs" ("job_id")
  WHERE "job_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Append-only ledgers.
--
-- A BEFORE trigger that raises is used rather than a RULE: rules silently
-- rewrite statements, a trigger gives the caller a clear error and a code the
-- application layer can assert on in tests.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "seo_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "issue_occurrences_append_only" ON "issue_occurrences";
CREATE TRIGGER "issue_occurrences_append_only"
  BEFORE UPDATE OR DELETE ON "issue_occurrences"
  FOR EACH ROW EXECUTE FUNCTION "seo_reject_mutation"();

DROP TRIGGER IF EXISTS "audit_log_append_only" ON "audit_log";
CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "seo_reject_mutation"();

-- ---------------------------------------------------------------------------
-- 3) Restricted fix actions can never be auto-applied.
--
-- The agent is also gated in code, but a redirect / URL change / page merge
-- that reaches APPLYING or APPLIED without an APPROVED approval row is a bug we
-- refuse to persist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "seo_require_approval"() RETURNS trigger AS $$
DECLARE
  needs_approval boolean;
  has_approval boolean;
BEGIN
  needs_approval := NEW."risk" IN ('SENSITIVE', 'RESTRICTED')
                 OR NEW."action" IN ('REDIRECT', 'URL_CHANGE', 'PAGE_MERGE');

  IF needs_approval AND NEW."status" IN ('APPLYING', 'APPLIED') THEN
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "fix_proposals_require_approval" ON "fix_proposals";
CREATE TRIGGER "fix_proposals_require_approval"
  BEFORE INSERT OR UPDATE ON "fix_proposals"
  FOR EACH ROW EXECUTE FUNCTION "seo_require_approval"();
