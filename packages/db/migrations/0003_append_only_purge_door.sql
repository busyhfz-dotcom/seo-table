-- Append-only, with one explicit door.
--
-- UPDATE is never permitted: history is not editable, full stop.
--
-- DELETE is permitted only inside a transaction that has opted in with
--   SET LOCAL seo.allow_purge = 'on';
-- which is what the retention job, an account-erasure request and the test
-- teardown do. No ordinary query path sets it, so a cascade or a stray script
-- still fails. The point is that erasing a ledger has to be a deliberate,
-- greppable act rather than a side effect of deleting a parent row.
CREATE OR REPLACE FUNCTION "seo_reject_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('seo.allow_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    '% is append-only; % is not permitted (a purge must SET LOCAL seo.allow_purge = ''on'')',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
