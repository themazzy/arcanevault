-- A `maintenance` schema for operational artifacts, and the fix for one that
-- should never have been in `public`.
--
-- The rollback snapshot from 20260802000000_repair_cards_qty_drift was created
-- with `create table public.cards_qty_repair_20260802 as select ...`. Two things
-- about that are wrong and neither is obvious:
--
--   1. `create table ... as` does NOT enable row level security.
--   2. Supabase's default privileges on `public` granted anon and authenticated
--      `arwdDxtm` on it — full SELECT, INSERT, UPDATE and DELETE.
--
-- So a throwaway snapshot holding 35 rows of (id, user_id, old_qty, new_qty)
-- became readable AND writable over the REST API by unauthenticated callers.
-- user_id is a value the app deliberately never publishes — get_public_profile
-- omits it precisely so profiles cannot be correlated to auth identities. The
-- Supabase advisor caught it as its only ERROR-level finding.
--
-- The durable fix is not "remember to enable RLS on temp tables". PostgREST only
-- exposes `public` (and graphql_public), so a table in an unexposed schema is
-- unreachable over the API regardless of RLS or grants. That is a structural
-- guarantee rather than a thing to remember.
--
-- Put future snapshots, backfill staging tables and one-off repair artifacts
-- here, not in public.
create schema if not exists maintenance;
revoke all on schema maintenance from anon, authenticated, public;

-- Idempotent: only moves the table if it is still sitting in public.
do $$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cards_qty_repair_20260802'
  ) then
    execute 'alter table public.cards_qty_repair_20260802 set schema maintenance';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'maintenance' and c.relname = 'cards_qty_repair_20260802'
  ) then
    execute 'revoke all on maintenance.cards_qty_repair_20260802 from anon, authenticated, public';
    -- No policies, so no rows for any non-superuser role that somehow reaches
    -- it. The rls_enabled_no_policy advisor INFO on this table is the intent,
    -- not a defect.
    execute 'alter table maintenance.cards_qty_repair_20260802 enable row level security';
  end if;
end $$;

notify pgrst, 'reload schema';
