-- The Scryfall metadata cache TTL is now a static 24h constant
-- (SCRYFALL_CACHE_TTL_MS in src/lib/scryfall.js) rather than a user preference.
-- No client reads or writes this column anymore.
alter table public.user_settings drop column if exists cache_ttl_h;
