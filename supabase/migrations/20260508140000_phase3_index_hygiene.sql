-- Phase 3 — Index hygiene (2026-05-08).
--
-- 1. Drop 8 indexes flagged as 0-scan since creation.
-- 2. Add covering indexes for 9 unindexed FKs (skipping deck_cards.category_id
--    which was deliberately dropped this morning in 20260508000001 — the FK
--    target table is small and never has its PK rewritten, so the FK-check
--    cost is negligible).
-- 3. REINDEX card_prices_stage to clear bloat (47 MB PK index over 0 live
--    rows; publish flow leaves dead tuples that VACUUM can't reclaim).
--
-- All operations are non-destructive to data. Indexes are pure metadata.

-- ── 1. Drop unused indexes ──────────────────────────────────────────────────
drop index if exists public.game_sessions_retention_idx;
drop index if exists public.game_results_user_played_idx;
drop index if exists public.game_results_game_idx;
drop index if exists public.card_prices_stage_set_collector_snapshot_idx;  -- 19 MB
drop index if exists public.account_deletion_requests_user_email_idx;
drop index if exists public.account_deletion_request_events_request_id_created_at_idx;
drop index if exists public.deck_categories_deck_id_idx;
drop index if exists public.deck_categories_deck_sort_idx;

-- ── 2. Add covering FK indexes (small btrees) ───────────────────────────────
create index if not exists account_deletion_request_events_actor_user_id_idx
  on public.account_deletion_request_events (actor_user_id);
create index if not exists account_deletion_requests_processed_by_idx
  on public.account_deletion_requests (processed_by);
create index if not exists feedback_user_id_idx
  on public.feedback (user_id);
create index if not exists feedback_attachments_user_id_idx
  on public.feedback_attachments (user_id);
create index if not exists game_players_user_id_idx
  on public.game_players (user_id);
create index if not exists game_results_session_id_idx
  on public.game_results (session_id);
create index if not exists game_sessions_host_user_id_idx
  on public.game_sessions (host_user_id);
create index if not exists tournament_players_user_id_idx
  on public.tournament_players (user_id);
create index if not exists tournament_sessions_host_user_id_idx
  on public.tournament_sessions (host_user_id);

-- ── 3. Reclaim card_prices_stage index bloat ────────────────────────────────
-- Brief AccessExclusiveLock; table has 0 live rows so completes in <1s.
reindex table public.card_prices_stage;
