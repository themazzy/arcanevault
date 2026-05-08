-- Security advisor remediations (2026-05-08)
--
-- 1. app_config: replace blanket authenticated write policy with admin-only.
--    Only Admin.jsx writes app_config (changelog, feedback_resolved); reads
--    are unaffected (the existing `read_all` policy still applies).
--
-- 2. Revoke EXECUTE on internal SECURITY DEFINER functions from anon &
--    authenticated. None of these are called from client code:
--      - cleanup_old_game_sessions: cron/admin only
--      - publish_card_prices: GitHub Actions price-sync (service_role)
--      - reconcile_owned_card_after_trade: internal helper invoked by
--        commit_trade, which is itself SECURITY DEFINER and bypasses the grant
--    commit_trade keeps its grant (called from Trading.jsx).
--
-- 3. Pin search_path on three functions flagged with mutable search_path.

-- ── 1. app_config admin-only writes ──────────────────────────────────────────
drop policy if exists "write_authenticated" on public.app_config;

create policy "write_admin"
  on public.app_config
  for all
  to authenticated
  using (
    exists (
      select 1 from public.admin_users a
      where a.user_id = auth.uid() and a.active = true
    )
  )
  with check (
    exists (
      select 1 from public.admin_users a
      where a.user_id = auth.uid() and a.active = true
    )
  );

-- ── 2. Revoke EXECUTE on internal SECDEF functions ───────────────────────────
revoke execute on function public.cleanup_old_game_sessions(interval) from anon, authenticated;
revoke execute on function public.publish_card_prices(date, date) from anon, authenticated;
revoke execute on function public.reconcile_owned_card_after_trade(uuid, uuid) from anon, authenticated;

-- ── 3. Pin search_path on flagged functions ──────────────────────────────────
alter function public.safe_jsonb(text) set search_path = public, pg_temp;
alter function public.validate_deck_card_category() set search_path = public, pg_temp;
alter function public.is_username_available(text) set search_path = public, pg_temp;
