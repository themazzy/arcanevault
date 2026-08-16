-- Data-correctness invariants.
--
-- These are the rules CLAUDE.md states must hold but which nothing enforces
-- at write time. They cannot be checked from the client: RLS scopes `cards`
-- and `folders` to the calling user, so an anon or authenticated session sees
-- only its own rows and a cross-user drift would be invisible. Run this in the
-- Supabase SQL editor, or via the MCP `execute_sql` tool.
--
-- Every column below should read 0. A non-zero value is a real inconsistency,
-- not a threshold to tune.
--
-- Baseline recorded 2026-08-16 over 22,139 cards / 299 folders:
--   all zero except linked_pair_name_drift = 1 (one pair linked under two
--   different names in a single transaction — pre-existing, not a live bug).
--
-- One caveat on that baseline: there were 0 group folders in the database at
-- the time, so the group_folders block passed without exercising anything.
-- Treat its zeros as "not yet tested", not as evidence the guard works.

-- ── Ownership arithmetic ─────────────────────────────────────────────────────
-- `cards.qty` must equal the sum of that row's placements, and an owned card
-- must be placed somewhere. change_owned_card_identity() maintains this inside
-- one transaction precisely because separate client writes could break it
-- mid-way.
with placements as (
  select c.id, c.qty,
    coalesce((select sum(fc.qty) from folder_cards      fc where fc.card_id = c.id), 0)
  + coalesce((select sum(da.qty) from deck_allocations  da where da.card_id = c.id), 0) as placed,
    (select count(*) from folder_cards     fc where fc.card_id = c.id)
  + (select count(*) from deck_allocations da where da.card_id = c.id) as n_places
  from cards c
)
select
  'ownership' as check_group,
  (select count(*) from placements where qty <> placed)   as qty_mismatch,
  (select count(*) from placements where n_places = 0)    as orphan_cards,
  -- A zero-qty allocation violates deck_allocations_qty_check; an emptied
  -- slot must be deleted, never decremented to 0.
  (select count(*) from deck_allocations where qty <= 0)  as zero_qty_allocs,
  (select count(*) from folder_cards      where qty <= 0) as zero_qty_folder_cards,
  (select count(*) from cards)                            as total_cards;

-- ── Linked deck pairs ────────────────────────────────────────────────────────
-- A pair is two `folders` rows. Links must be reciprocal, and anything shown
-- for "the deck" must be written to both — renames go through the
-- rename_folder RPC for exactly this reason.
--
-- `description` is TEXT, not jsonb, and is not guaranteed to hold JSON, so the
-- cast is guarded on a leading brace. An unguarded `description::jsonb` errors
-- out on the first non-JSON row rather than returning a result.
with parsed as (
  select id, type, name,
    case when description ~ '^\s*\{' then description::jsonb end as meta
  from folders
), m as (
  select id, type, name,
    nullif(meta->>'linked_deck_id',    '')::uuid as linked_deck_id,
    nullif(meta->>'linked_builder_id', '')::uuid as linked_builder_id
  from parsed where meta is not null
)
select
  'linked_pairs' as check_group,
  (select count(*) from m where linked_deck_id is not null
     and not exists (select 1 from m o where o.id = m.linked_deck_id
                                         and o.linked_builder_id = m.id)) as builder_link_not_reciprocated,
  (select count(*) from m where linked_builder_id is not null
     and not exists (select 1 from m o where o.id = m.linked_builder_id
                                         and o.linked_deck_id = m.id))    as collection_link_not_reciprocated,
  (select count(*) from m join m o on o.id = m.linked_deck_id
     where m.name is distinct from o.name)                                as linked_pair_name_drift,
  (select count(*) from m where linked_deck_id is not null)               as builder_links;

-- ── Group folders ────────────────────────────────────────────────────────────
-- Folders flagged {"isGroup": true} are organisational containers. They must
-- never hold placements — isGroupFolder() excludes them from folder_cards
-- queries, so any row here is a write that bypassed that guard.
with parsed as (
  select id, name, case when description ~ '^\s*\{' then description::jsonb end as meta
  from folders
)
select
  'group_folders' as check_group,
  (select count(*) from folder_cards fc
     join parsed p on p.id = fc.folder_id
    where (p.meta->>'isGroup')::boolean is true)     as placements_in_group_folders,
  (select count(*) from deck_allocations da
     join parsed p on p.id = da.deck_id
    where (p.meta->>'isGroup')::boolean is true)     as allocations_in_group_folders;
