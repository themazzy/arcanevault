-- Phase 1 — Security lockdown (2026-05-08).
--
-- The earlier `20260508110816_security_advisor_fixes` revoked EXECUTE on
-- internal SECURITY DEFINER functions from `anon` and `authenticated`, but
-- missed the implicit PUBLIC grant that CREATE FUNCTION installs by default
-- (visible as the `=X/postgres` ACL entry). Because PUBLIC includes anon and
-- authenticated, the advisor still flags every DEFINER function.
--
-- Strategy:
--   1. REVOKE EXECUTE … FROM PUBLIC on every public.* SECURITY DEFINER fn.
--   2. Re-GRANT EXECUTE explicitly to the role(s) that should call each one.
--   3. Drop the obsolete `card_schema_migration_audit` audit table (3 rows,
--      no client references — sweep verified by grep across src/).
--   4. Add a minimal service_role-only RLS policy on `card_prices_stage` so
--      it stops tripping the rls_enabled_no_policy lint while we decide its
--      fate in Phase 6.
--
-- Deferred to a follow-up: moving pgcrypto out of public schema. 36 objects
-- depend on it and the `shared_folders.public_token` default expression
-- relies on the unqualified `gen_random_bytes()` resolving via search_path,
-- which only `postgres` has set to include `extensions`.

-- ── 1. Lock down DEFINER functions ──────────────────────────────────────────
-- Internal-only (called by cron / GitHub Actions / other DEFINER fns):
revoke execute on function public.cleanup_old_game_sessions(interval) from public;
revoke execute on function public.publish_card_prices(date, date) from public;
revoke execute on function public.reconcile_owned_card_after_trade(uuid, uuid) from public;
-- service_role bypasses RLS and EXECUTE checks, but make the intent explicit:
grant execute on function public.cleanup_old_game_sessions(interval) to service_role;
grant execute on function public.publish_card_prices(date, date) to service_role;
grant execute on function public.reconcile_owned_card_after_trade(uuid, uuid) to service_role;

-- Authenticated-only (Trading.jsx → commit_trade; Settings/SetupWizard → is_username_available):
revoke execute on function public.commit_trade(jsonb, jsonb) from public;
revoke execute on function public.is_username_available(text) from public;
revoke execute on function public.get_my_decks() from public;
grant execute on function public.commit_trade(jsonb, jsonb) to authenticated;
grant execute on function public.is_username_available(text) to authenticated;
grant execute on function public.get_my_decks() to authenticated;

-- Public discovery RPCs — anon + authenticated (Profile, Builder community,
-- DeckView shortlinks, MilestoneWatcher):
revoke execute on function public.get_community_decks() from public;
revoke execute on function public.get_deck_cards_for_view(uuid) from public;
revoke execute on function public.get_public_decks(text) from public;
revoke execute on function public.get_public_profile(text) from public;
revoke execute on function public.get_user_nickname(uuid) from public;
grant execute on function public.get_community_decks() to anon, authenticated;
grant execute on function public.get_deck_cards_for_view(uuid) to anon, authenticated;
grant execute on function public.get_public_decks(text) to anon, authenticated;
grant execute on function public.get_public_profile(text) to anon, authenticated;
grant execute on function public.get_user_nickname(uuid) to anon, authenticated;

-- ── 2. Drop obsolete migration audit table ──────────────────────────────────
-- Backfilled during the card_prints/card_print_id schema migration. No client
-- code references it (verified). Dropping clears the rls_enabled_no_policy
-- lint and ~32 kB of unused storage.
drop table if exists public.card_schema_migration_audit;

-- ── 3. card_prices_stage RLS policy ─────────────────────────────────────────
-- Empty staging table written only by the price-publish edge function (which
-- uses the service_role key and bypasses RLS regardless). Add an explicit
-- empty-set policy for anon/authenticated so the linter is satisfied; no role
-- besides service_role can touch the table.
do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.card_prices_stage'::regclass
      and polname = 'no_client_access'
  ) then
    create policy "no_client_access"
      on public.card_prices_stage
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end$$;
