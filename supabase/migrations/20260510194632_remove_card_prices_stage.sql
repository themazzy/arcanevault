-- Phase 6.2 option B: price sync now publishes directly into card_prices, so
-- the staging table and its SECURITY DEFINER publisher are no longer needed.

drop function if exists public.publish_card_prices(date, date);
drop table if exists public.card_prices_stage;
