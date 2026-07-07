-- Service-role helper to bulk-fill card_prints.oracle_text from a JSON payload
-- of { oid, txt } pairs, matched by oracle_id. Used by the one-off seed script
-- scripts/backfill-oracle-text.mjs (and any future re-seed): far fewer round
-- trips than per-row updates, and avoids partial upserts that would trip
-- card_prints' NOT NULL columns. Idempotent — only fills rows still NULL, so
-- re-runs are cheap and don't churn dead tuples on already-seeded rows.

CREATE OR REPLACE FUNCTION public.apply_card_oracle_text(payload jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE card_prints cp
     SET oracle_text = e.txt
    FROM jsonb_to_recordset(payload) AS e(oid text, txt text)
   WHERE cp.oracle_id = e.oid
     AND cp.oracle_text IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Maintenance-only: never callable from the client.
REVOKE ALL ON FUNCTION public.apply_card_oracle_text(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_card_oracle_text(jsonb) TO service_role;
