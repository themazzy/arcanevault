# Price Sync Plan

## Goal

Replace the current per-user daily snapshot cron with a shared card-price sync that keeps only today's and yesterday's market prices.

This keeps the features the app actually needs:

- current market value
- 24h change
- P&L vs buy price

This removes the parts we do not need right now:

- long-term portfolio history
- multi-week or multi-month value charts
- older market snapshots for every card

## Why Change It

The current Supabase cron design is expensive in the wrong way:

- it loops through users instead of pricing cards globally
- it refetches the same card prices many times when multiple users own the same printing
- it stores per-user portfolio snapshots even though the app does not need long-term portfolio history

The app already stores each card's buy price in `cards.purchase_price`, and current P&L is derived from:

`(current_price_eur - purchase_price) * qty`

That means we do not need long-term market history to support P&L.

## Target Design

Use one shared table for market prices instead of per-user daily snapshots.

Recommended shape:

`card_prices`

- `scryfall_id text not null`
- `set_code text not null`
- `collector_number text not null`
- `snapshot_date date not null`
- `price_regular numeric(10,2)`
- `price_foil numeric(10,2)`
- `currency text not null default 'EUR'`
- `updated_at timestamptz not null default now()`
- unique key on `scryfall_id, snapshot_date`

Retention:

- keep only `today`
- keep only `yesterday`
- delete anything older

This can also be split into `current_card_prices` and `previous_card_prices`, but a single table with `snapshot_date` is simpler.

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
2. transform it to the compact pricing shape used by ArcaneVault
3. write today's rows into `card_prices`
4. keep yesterday's rows
5. delete rows older than yesterday

Expected cost:

- likely zero on GitHub Free if the repository usage stays below included monthly minutes
- this job should be well within the free minutes budget for a once-daily Linux workflow

## App Changes

Replace logic that depends on `price_snapshots` with shared price reads.

The app should compute:

- current collection value from today's shared prices
- day-over-day change from today's vs yesterday's shared prices
- P&L from today's shared price vs `cards.purchase_price`

The app should no longer depend on long-term snapshot history.

## Collection Tab Impact

Collection syncing should continue to work the same for user-owned cards, folders, and offline cache.

What changes:

- the Collection tab should stop fetching live price data from Scryfall for valuation
- prices should come from the shared Supabase `card_prices` table
- the manual price refresh action on the Collection tab should be removed
- client-side Scryfall cache should be treated as metadata and image cache, not the source of live pricing

Expected result:

- no manual price sync button
- no per-device price drift caused by stale local price cache
- faster and more consistent collection valuation

## Database Changes

Planned changes:

- add new `card_prices` table
- add indexes for lookup by `scryfall_id` and `snapshot_date`
- stop using the current `price_snapshots` cron flow
- remove or deprecate `supabase/cron.sql`
- remove or deprecate `supabase/functions/daily-snapshot`

## Migration Path

1. Add the new `card_prices` schema.
2. Create the import script that reads Scryfall bulk data and upserts only needed fields.
3. Add a GitHub Actions workflow to run the import once per day.
4. Update app queries to use shared prices instead of `price_snapshots` where appropriate.
5. Update the Collection tab so price display no longer depends on client-side Scryfall refreshes.
6. Remove the manual Collection tab price refresh flow.
7. Reduce the Stats page from long-term history to current value plus 24h movement.
8. Disable the old Supabase cron-based snapshot flow.

## Open Questions

- whether to key strictly by `scryfall_id` or keep `set_code + collector_number` as a secondary lookup path
- whether to store only EUR prices or both EUR and USD
- whether list items should also use shared day-over-day pricing in exactly the same way as owned cards

## Recommendation

Proceed with:

- one shared `card_prices` table
- two-day retention only
- GitHub Actions daily refresh
- no per-user daily snapshot job

This is cheaper, simpler, and matches the product as it exists today.
