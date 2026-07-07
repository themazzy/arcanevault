-- Speed up "all printings of a card by name" lookups used by the deck-builder
-- printing optimizer (replaces per-card Scryfall search calls).
create index if not exists card_prints_name_idx on public.card_prints (name);
