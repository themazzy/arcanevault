-- Give the oracle sync a change key that actually exists.
--
-- sync-oracle-cards.mjs has always tried to skip unchanged rows by comparing
-- oracle_cards.source_updated_at against the incoming card's `updated_at`. That
-- premise is wrong: Scryfall's ORACLE BULK export carries no `updated_at` field
-- at all (a live record has `released_at` and `image_updated_at`, nothing else),
-- so the column is NULL for all 38,753 rows and needsWrite's
-- `if (!stored || !row.source_updated_at) return true` forced a write on every
-- row of every run.
--
-- The cost is table bloat, because Postgres implements UPDATE as
-- insert-new-tuple + mark-old-dead. Measured 2026-09-13: 94 MB of heap holding
-- 46 MB of live rows — 49.9% empty, almost exactly one full rewrite's worth, on
-- a 500 MB database. Autovacuum reclaims the dead tuples but returns the pages
-- to the table's free space map, never to the OS, so the file sits at its
-- high-water mark. This was measured and VACUUM FULL'd once before, on
-- 2026-08-01; the skip that was supposed to stop it coming back never fired.
--
-- content_hash is a digest of the row we would write, excluding synced_at
-- (which changes every run by definition). A weekly run now writes only the
-- cards that genuinely changed.
--
-- It replaces --force for shape changes too: when oracleCardRow() gains or
-- drops a column the digest changes for every row, so the rewrite happens on
-- its own rather than needing someone to remember the flag.
--
-- Nullable with no default, so this is a metadata-only change — no table
-- rewrite. Existing rows have a NULL hash and are written once on the next run,
-- which is what populates them.
--
-- source_updated_at is deliberately KEPT despite being permanently NULL:
-- get_recommendation_card_metadata orders candidates by
-- coalesce(oc.source_updated_at, oc.synced_at), so dropping it would mean
-- rewriting that function for no gain.

alter table public.oracle_cards
  add column if not exists content_hash text;

comment on column public.oracle_cards.content_hash is
  'Digest of the synced row (excluding synced_at). The oracle sync skips a card whose digest is unchanged. Do not use source_updated_at for this — Scryfall''s oracle bulk export has no per-card updated_at.';
