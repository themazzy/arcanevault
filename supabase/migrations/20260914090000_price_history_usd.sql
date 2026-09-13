-- TCGplayer (USD) price history alongside Cardmarket (EUR).
--
-- PRICE_SOURCES in src/lib/scryfall.js offers exactly two markets —
-- cardmarket_trend (EUR) and tcgplayer_market (USD) — and the chart previously
-- showed only the first regardless of which one the user had selected, so a
-- TCGplayer user read a currency they do not price in.
--
-- Both series come from the same MTGJSON AllPrices file already being ingested:
-- paper.tcgplayer.retail, USD, same {normal, foil} shape as cardmarket.
-- Coverage measured 2026-09-14: 99,831 printings have TCGplayer retail against
-- 101,380 for Cardmarket, 96,801 have both.
--
-- Cost is ~24 MB of a 500 MB database, funded by the index rebuild and vacuum
-- that took it from 388 MB to 358 MB. MTGJSON also carries cardkingdom,
-- manapool, a buylist per provider, and a TCGplayer `etched` finish on ~1,200
-- printings — none stored, because no PRICE_SOURCES entry can display them and
-- each extra series costs the same again.
--
-- Nullable with no default, so this is metadata-only: no table rewrite. Existing
-- rows carry NULL until the next ingest fills them.

alter table public.card_price_history
  add column if not exists prices_usd      real[],
  add column if not exists prices_usd_foil real[];

comment on column public.card_price_history.prices_usd is
  'TCGplayer USD series, index-aligned to start_date exactly as prices_eur. NULL where TCGplayer has no price for the printing.';
comment on column public.card_price_history.prices_usd_foil is
  'TCGplayer USD foil series, index-aligned to start_date.';
