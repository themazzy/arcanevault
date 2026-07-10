-- card_prices_lookup_cover duplicated the primary key (scryfall_id,
-- snapshot_date) with two INCLUDEd eur price columns — but every reader
-- (sharedCardPrices, cardSearch, deckBuilderApi, the profile/trade/snapshot
-- RPCs) selects all four price columns, so the index never enabled an
-- index-only scan; the PK serves the identical lookups. Dropping it (plus
-- REINDEXing the churn-bloated card_prices indexes, done operationally)
-- reclaimed ~64 MB.
drop index if exists public.card_prices_lookup_cover;
