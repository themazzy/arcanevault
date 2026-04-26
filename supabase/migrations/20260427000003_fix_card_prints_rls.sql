-- SEC-003: card_prints had permissive INSERT (with check true) and UPDATE
-- (using true / with check true) policies, letting any authenticated user
-- overwrite shared card metadata (names, image URIs) for all users.
--
-- Fix: prohibit UPDATE from authenticated clients entirely.
-- Scope INSERT to new scryfall_id rows only — prevents overwriting existing metadata.

-- remove the permissive policies from the earlier migration
drop policy if exists "authenticated insert card_prints" on public.card_prints;
drop policy if exists "authenticated update card_prints" on public.card_prints;

revoke update on public.card_prints from authenticated;

-- insert is still allowed, but only for scryfall_ids not yet in the table.
-- in RLS WITH CHECK expressions, unqualified column names refer to the incoming
-- row — no "new." prefix (that's trigger syntax, not policy syntax).
create policy "authenticated insert card_prints new only"
  on public.card_prints
  for insert
  to authenticated
  with check (
    not exists (
      select 1 from public.card_prints existing_cp
      where existing_cp.scryfall_id = scryfall_id
    )
  );
