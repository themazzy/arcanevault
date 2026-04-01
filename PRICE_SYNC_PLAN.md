# Price Sync Plan

This plan has been implemented. It now documents the current price-sync architecture used by the app.

## Goal

Use a shared card-price sync that keeps only today's and yesterday's market prices.

This keeps the features the app actually needs:

- current market value
- 24h change
- P&L vs buy price

This removes the parts we do not need right now:

- long-term portfolio history
- multi-week or multi-month value charts
- older market snapshots for every card

## Why It Changed

The old per-user snapshot design was expensive in the wrong way:

- it looped through users instead of pricing cards globally
- it refetched the same card prices many times when multiple users owned the same printing
- it stored per-user portfolio snapshots even though the app does not need long-term portfolio history

The app already stores each card's buy price in `cards.purchase_price`, and current P&L is derived from:

`(current_price_eur - purchase_price) * qty`

That means we do not need long-term market history to support P&L.

## Current Design

Use one shared table for market prices instead of per-user daily snapshots.

Recommended shape:

`card_prices`

- `scryfall_id text not null`
- `set_code text not null`
- `collector_number text not null`
- `snapshot_date date not null`
- `price_regular_eur numeric(10,2)`
- `price_foil_eur numeric(10,2)`
- `price_regular_usd numeric(10,2)`
- `price_foil_usd numeric(10,2)`
- `updated_at timestamptz not null default now()`
- primary key on `scryfall_id, snapshot_date`

Retention:

- keep only `today`
- keep only `yesterday`
- delete anything older

Atomic publish:

- the importer stages rows in `card_prices_stage`
- after a full successful import, `publish_card_prices(snapshot_date, retention_cutoff)` replaces that day's live dataset in one publish step
- this prevents stale same-day leftovers and avoids exposing partial `today` data during a run

## Data Source

Do not fetch 110,000 cards one by one.

Use Scryfall bulk data once per day, extract only the fields needed for pricing, then upsert into Supabase.

Why bulk data:

- fewer requests
- more reliable than mass per-card API calls
- better fit for Scryfall's intended usage for large datasets

## Runtime Location

Do not rely on a Supabase Edge Function on the free plan for the full import job.

Reason:

- storage in Supabase free is likely fine for this dataset
- full bulk download, parse, and upsert is better handled outside Supabase
- GitHub Actions is a better scheduler for this job

## Scheduler

Use a daily GitHub Actions workflow on a Linux runner.

The workflow should:

1. download the latest Scryfall bulk card data
2. stream and filter it to the compact priced-paper dataset used by ArcaneVault
3. write today's rows into `card_prices_stage`
4. publish the staged rows into `card_prices`
5. keep yesterday's rows
6. delete rows older than yesterday

Current workflow file:

- `.github/workflows/card-price-sync.yml`

Current schedule:

- `20 3 * * *` (`03:20 UTC` daily)

Expected cost:

- likely zero on GitHub Free if the repository usage stays below included monthly minutes
- this job should be well within the free minutes budget for a once-daily Linux workflow

## App Changes

The app now uses shared price reads instead of per-user snapshots.

The app should compute:

- current collection value from today's shared prices
- day-over-day change from today's vs yesterday's shared prices
- P&L from today's shared price vs `cards.purchase_price`

Long-term market history is no longer part of the active price architecture.

## Collection Tab Impact

Collection syncing should continue to work the same for user-owned cards, folders, and offline cache.

What changes:

- the Collection tab no longer fetches live price data from Scryfall for valuation
- prices should come from the shared Supabase `card_prices` table
- the manual price refresh action on the Collection tab has been removed
- client-side Scryfall cache should be treated as metadata and image cache, not the source of live pricing

Expected result:

- no manual price sync button
- no per-device price drift caused by stale local price cache
- faster and more consistent collection valuation

## Database Changes

Implemented changes:

- added `card_prices`
- added `card_prices_stage`
- added indexes for `snapshot_date` and `set_code + collector_number + snapshot_date`
- added `publish_card_prices(...)`
- removed the old `price_snapshots` flow
- removed `supabase/cron.sql`
- removed `supabase/functions/daily-snapshot`

## Current Migration Set

Applied migrations for this architecture:

1. `20260401000003_card_prices_shared_daily.sql`
2. `20260402000001_card_prices_atomic_publish.sql`
3. `20260402000002_remove_legacy_price_snapshots.sql`

## Result

The project now uses:

- one shared `card_prices` table for live reads
- one staging table for atomic publish
- two-day retention only
- GitHub Actions daily refresh
- no per-user daily snapshot job

This is cheaper, simpler, and matches the product as it exists today.
