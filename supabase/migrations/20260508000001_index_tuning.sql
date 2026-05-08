-- Index tuning based on live pg_stat_user_indexes data (2026-05-08).
--
-- 1. Add cards(name) — Index Advisor reports 83-90% planner cost reduction
--    for two top-N slow queries that filter cards by name.
-- 2. Drop cards_user_scryfall_idx — 0 scans since creation, redundant with
--    cards_scryfall_id_idx + cards_user_id_idx.
-- 3. Drop deck_cards_category_id_idx — 0 scans since creation.

CREATE INDEX IF NOT EXISTS cards_name_idx ON public.cards USING btree (name);

DROP INDEX IF EXISTS public.cards_user_scryfall_idx;
DROP INDEX IF EXISTS public.deck_cards_category_id_idx;
