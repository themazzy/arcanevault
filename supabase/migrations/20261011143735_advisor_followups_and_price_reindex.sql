-- Database advisor follow-ups (2026-10-11) and a weekly reindex of card_prices.
--
-- 1. auth_rls_initplan: three policies called auth.uid() bare, so Postgres
--    re-evaluated it for every row instead of once per statement. Wrapping it
--    in a scalar subquery is the documented fix and does not change who can
--    read what.
--
-- 2. unindexed_foreign_keys: seven FKs had no covering index. All seven point
--    at a user, deck or comment and are ON DELETE CASCADE/SET NULL targets, so
--    deleting an account or a deck seq-scanned each child table to find rows.
--    The tables are small today; the indexes are a few kB each.
--
-- 3. card_prices index bloat. The daily sync rewrites every row of today's
--    snapshot, and the btrees never shrink on their own: on 2026-09-18 six of
--    them had drifted to ~46% leaf density and a manual reindex reclaimed
--    28 MB, and by 2026-10-11 card_prices_pkey was back to 26 MB for 204k rows
--    (about twice its packed size). A weekly REINDEX CONCURRENTLY keeps that
--    from regrowing between manual passes. CONCURRENTLY builds each new index
--    beside the old one (peak cost ~41 MB of temporary space, fine at
--    341/500 MB) and never blocks reads or the sync's writes. It cannot run in
--    a transaction block, which is why it is a pg_cron command (pg_cron sends
--    it as a top-level statement) rather than part of this migration.
--    Sunday 05:20 UTC: after the 03:20 price sync and the 04:xx jobs.
--
-- Deliberately not done: the advisor's seven "unused index" findings are on
-- game_* and feedback, tables small enough that the planner prefers a seq
-- scan today. They will start earning their keep as those tables grow, and
-- they cost almost nothing to keep.

alter policy deck_view_stats_owner_read on public.deck_view_stats
  using (exists (
    select 1 from public.folders f
    where f.id = deck_view_stats.deck_id and f.user_id = (select auth.uid())
  ));

alter policy deck_view_daily_owner_read on public.deck_view_daily
  using (exists (
    select 1 from public.folders f
    where f.id = deck_view_daily.deck_id and f.user_id = (select auth.uid())
  ));

alter policy trade_proposals_select on public.trade_proposals
  using ((select auth.uid()) = owner_id or (select auth.uid()) = proposer_id);

create index if not exists deck_changes_user_id_idx      on public.deck_changes (user_id);
create index if not exists deck_comments_user_id_idx     on public.deck_comments (user_id);
create index if not exists deck_likes_user_id_idx        on public.deck_likes (user_id);
create index if not exists list_items_claimed_by_idx     on public.list_items (claimed_by);
create index if not exists notifications_actor_id_idx   on public.notifications (actor_id);
create index if not exists notifications_comment_id_idx on public.notifications (comment_id);
create index if not exists notifications_deck_id_idx    on public.notifications (deck_id);

select cron.schedule(
  'weekly-card-prices-reindex',
  '20 5 * * 0',
  'reindex table concurrently public.card_prices'
);
