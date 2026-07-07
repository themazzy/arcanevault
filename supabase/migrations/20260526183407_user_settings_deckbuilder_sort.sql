-- Adds a deck-builder-specific sort preference. Mirrors `default_sort`
-- (collection / binders / decks / wishlists) but only applied by DeckBuilder.
alter table user_settings
  add column if not exists deckbuilder_sort text default 'price_asc';
