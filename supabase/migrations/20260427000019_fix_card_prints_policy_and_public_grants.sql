-- Follow-up repair for the drift-repair migration:
-- 1. qualify outer-row references in the card_prints INSERT policy
-- 2. revoke lingering PUBLIC execute on get_my_decks()
-- 3. remove storage.buckets write grants inherited by anon/authenticated

drop policy if exists "authenticated insert card_prints new only" on public.card_prints;

create policy "authenticated insert card_prints new only"
  on public.card_prints
  for insert
  to authenticated
  with check (
    (
      scryfall_id is not null
      and not exists (
        select 1
        from public.card_prints existing_cp
        where existing_cp.scryfall_id = public.card_prints.scryfall_id
      )
    )
    or
    (
      scryfall_id is null
      and not exists (
        select 1
        from public.card_prints existing_cp
        where existing_cp.scryfall_id is null
          and existing_cp.set_code = public.card_prints.set_code
          and existing_cp.collector_number = public.card_prints.collector_number
      )
    )
  );

revoke execute on function public.get_my_decks() from public;
revoke execute on function public.get_my_decks() from anon;
grant execute on function public.get_my_decks() to authenticated;

revoke all on storage.buckets from public;
revoke all on storage.buckets from anon;
revoke all on storage.buckets from authenticated;
grant select on storage.buckets to anon;
grant select on storage.buckets to authenticated;
