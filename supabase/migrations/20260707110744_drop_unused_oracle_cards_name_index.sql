-- Recommendation lookup starts from card_prints.name and joins oracle_cards by
-- its oracle_id primary key, so a second index on oracle_cards.name is unused.

drop index if exists public.oracle_cards_name_idx;
