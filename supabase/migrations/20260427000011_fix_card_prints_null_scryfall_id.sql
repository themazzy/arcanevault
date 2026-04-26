-- NEW-5: The "no-overwrite" INSERT policy on card_prints checks scryfall_id uniqueness,
-- but rows where scryfall_id IS NULL would always pass the NOT EXISTS check (NULLs are
-- never equal) and allow unlimited duplicate inserts for the same physical print.
-- Extend the guard to also enforce uniqueness on (set_code, collector_number) for the
-- NULL-scryfall_id path.

drop policy if exists "authenticated insert card_prints new only" on public.card_prints;

create policy "authenticated insert card_prints new only"
  on public.card_prints for insert to authenticated
  with check (
    -- block if a row already exists with the same scryfall_id (non-null)
    (
      scryfall_id is not null
      and not exists (
        select 1 from public.card_prints existing_cp
        where existing_cp.scryfall_id = scryfall_id
      )
    )
    or
    -- block if a row already exists with the same (set_code, collector_number) for null ids
    (
      scryfall_id is null
      and not exists (
        select 1 from public.card_prints existing_cp
        where existing_cp.scryfall_id is null
          and existing_cp.set_code        = set_code
          and existing_cp.collector_number = collector_number
      )
    )
  );
