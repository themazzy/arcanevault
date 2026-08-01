-- DATA REPAIR. 35 `cards` rows violated the invariant CLAUDE.md states as
-- load-bearing: "cards.qty must always equal the sum of its placements".
--
-- Found during a database audit on 2026-08-01. All 35 drifted in one direction —
-- qty OVERCOUNTED versus actual placements by 49 copies total. None were
-- orphaned (every row still had at least one placement) and none were
-- over-allocated, which is the dangerous direction.
--
--   Styvivondr  33 rows, 47 phantom copies, 1,649 -> 1,602 cards (-2.85%), -EUR 7.89
--   Zer0h        2 rows,  2 phantom copies, 1,933 -> 1,931 cards (-0.10%), -EUR 0.21
--
-- Drift clustered on four days total (2026-05-19, 06-02, 07-16 and 07-03),
-- consistent with bulk remove/move operations that decremented placements
-- without adjusting cards.qty — the exact failure mode
-- change_owned_card_identity() exists to prevent by doing the split inside one
-- transaction. Some other write path is not that careful; worth finding, since
-- this repair fixes the symptom rather than the cause.
--
-- Why it mattered beyond overstated totals: change_owned_card_identity() splits
-- a row on the assumption that qty = sum(placements). A drifted row through that
-- RPC is where a cosmetic overcount becomes a real bug.
--
-- Nothing a user can see was removed. Placements were untouched (folder_cards
-- stayed at 19,257 rows across the repair) — every card tile remained in its
-- binder and deck. Only the row-level counter changed to match what is actually
-- placed.
--
-- Applied 2026-08-02. Pre-repair values are preserved in
-- maintenance.cards_qty_repair_20260802 (id, user_id, old_qty, new_qty,
-- captured_at) so this is reversible:
--   update cards c set qty = r.old_qty
--   from maintenance.cards_qty_repair_20260802 r where c.id = r.id;
-- Drop that table once you are satisfied the counts are right.
--
-- NOTE: that snapshot was first created in `public`, which was a mistake —
-- `create table ... as` does not enable RLS and Supabase's default privileges on
-- public granted anon full SELECT/INSERT/UPDATE/DELETE on it, exposing 35 rows
-- of (user_id, qty) over the REST API. Moved to the unexposed `maintenance`
-- schema by 20260802010000. Operational artifacts must never be created in
-- `public`.
--
-- Verified after: 0 mismatches, 0 orphans, 0 rows with qty < 1 across all
-- 21,948 rows. profile_stats was refreshed for both users so their profiles
-- stopped showing the stale totals.
--
-- This file documents an already-applied one-off repair. It is written to be
-- safely re-runnable (a no-op once the invariant holds) rather than to be the
-- thing that performed it.

do $$
declare v_fixed int;
begin
  with placed as (
    select c.id, c.qty,
           coalesce((select sum(fc.qty) from folder_cards fc where fc.card_id = c.id), 0)
         + coalesce((select sum(da.qty) from deck_allocations da where da.card_id = c.id), 0) as placed_qty
    from cards c
  ),
  drift as (
    -- Never let a repair zero a row: qty 0 violates the ownership rule and the
    -- deck_allocations qty check.
    select id, placed_qty from placed where qty <> placed_qty and placed_qty >= 1
  ),
  upd as (
    update cards c set qty = d.placed_qty, updated_at = now()
    from drift d where c.id = d.id
    returning 1
  )
  select count(*) into v_fixed from upd;

  if v_fixed > 0 then
    raise notice 'cards.qty drift repaired on % rows', v_fixed;
  end if;
end $$;
