-- 90-day price history per printing, for the chart on card detail.
--
-- SHAPE: one row per printing holding a fixed-origin array, NOT a row per
-- card per day. That distinction is the whole reason this is affordable.
-- card_prices is 42 MB for TWO days of the catalogue (~21 MB/day), so a
-- row-per-day history would be ~1.9 GB for 90 days — impossible on a 500 MB
-- database. As arrays it is ~65 MB.
--
-- SOURCE: MTGJSON's AllPrices export (MIT licensed), which publishes a rolling
-- ~90-day window and hands us the history immediately rather than making us
-- accumulate it for three months. Its `paper.cardmarket.retail` numbers were
-- verified byte-identical to card_prices.price_regular_eur (both are Cardmarket
-- trend via different routes), so the chart always ends on the number the rest
-- of the app already shows. EUR only, matching the hardcoded P&L source.
--
-- start_date is the date of prices_eur[1]. Every array is contiguous from
-- there, with NULL for days the source had no price — so the client can map
-- index -> date arithmetically and must render a gap rather than interpolating.
-- A missing day is genuinely missing; drawing through it invents a trend.

create table if not exists public.card_price_history (
  scryfall_id     text primary key,
  start_date      date not null,
  prices_eur      real[],
  prices_foil_eur real[],
  updated_at      timestamptz not null default now()
);

comment on table public.card_price_history is
  'Rolling ~90-day EUR price series per printing, one row per printing. Ingested daily from MTGJSON AllPrices by scripts/sync-price-history.mjs. prices_eur[i] is the price on start_date + (i-1) days; NULL means no price that day and must render as a gap, not an interpolation.';

alter table public.card_price_history enable row level security;

-- Price history is public reference data, exactly like card_prints: a signed-out
-- visitor on /d/<id> or /sets/<code> must be able to see a chart. Writes are
-- service_role only (the sync job); no client ever writes here.
drop policy if exists "card_price_history readable by everyone" on public.card_price_history;
create policy "card_price_history readable by everyone"
  on public.card_price_history for select
  to anon, authenticated
  using (true);

grant select on public.card_price_history to anon, authenticated;

-- New public-schema tables no longer auto-expose (Supabase changed the default
-- 2026-10-30), so the grant above is required, not incidental.
