-- P2: add explicit WITH CHECK on folder_cards "own folder_cards" ALL policy.
-- The qual was scoping reads correctly but inserts/updates relied on Postgres'
-- fallback (qual used as with_check). Being explicit prevents a future ALL→split
-- refactor from accidentally widening write access.
drop policy if exists "own folder_cards" on public.folder_cards;
create policy "own folder_cards"
on public.folder_cards
for all
to public
using (
  exists (
    select 1 from public.folders f
    where f.id = folder_cards.folder_id
      and f.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1 from public.folders f
    where f.id = folder_cards.folder_id
      and f.user_id = (select auth.uid())
  )
);

-- P2: simplify card_prints insert policy. The previous policy ran two NOT EXISTS
-- subqueries against a 119k-row table on every insert AND was racy under
-- concurrent inserts. Both uniqueness invariants are already enforced by
-- existing unique indexes:
--   card_prints_scryfall_id_key                 unique on scryfall_id
--   card_prints_null_scryfall_set_collector_idx partial unique on
--                                                (set_code, collector_number)
--                                                where scryfall_id is null
-- so callers can rely on ON CONFLICT DO NOTHING. The new policy keeps inserts
-- gated to authenticated users only.
drop policy if exists "authenticated insert card_prints new only" on public.card_prints;
create policy "authenticated insert card_prints"
on public.card_prints
for insert
to authenticated
with check (true);;
