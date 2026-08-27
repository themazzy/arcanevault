-- Schedule the deck_view_daily prune.
--
-- deck_view_daily holds one row per public deck per day. The Traffic tab's
-- widest range is 60 days and nothing else reads it, so rows past 180 days are
-- dead weight in a database already dominated by the Scryfall catalogue.
--
-- Pruning costs no reporting: deck_view_stats.total_views is the all-time
-- figure and is untouched. Only per-day granularity older than 180 days goes.
--
-- Weekly rather than daily: the delete is a no-op most days, and this project
-- has been bitten by dead-tuple churn before. Runs after the existing 04:2x-04:4x
-- maintenance jobs so they never overlap.
select cron.schedule(
  'weekly-deck-view-daily-prune',
  '50 4 * * 0',
  $$select public.prune_deck_view_daily()$$
);
