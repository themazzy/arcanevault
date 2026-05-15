-- Extend card_prints with the filter/sort/detail fields that previously lived
-- only in the per-user Scryfall IDB cache. This lets the client populate the
-- in-memory sfMap directly from card_prints (+ card_prices) without hitting
-- Scryfall for every owned print on every load.

alter table public.card_prints
  add column if not exists rarity           text,
  add column if not exists set_name         text,
  add column if not exists legalities       jsonb        not null default '{}'::jsonb,
  add column if not exists artist           text,
  add column if not exists oracle_text      text,
  add column if not exists power            text,
  add column if not exists toughness        text,
  add column if not exists produced_mana    text[]       not null default '{}'::text[],
  add column if not exists keywords         text[]       not null default '{}'::text[],
  add column if not exists colors           text[]       not null default '{}'::text[],
  add column if not exists image_uri_small  text,
  add column if not exists image_uri_large  text,
  add column if not exists card_faces       jsonb;

-- The previous policy set blocks UPDATE entirely (insert-only for authenticated).
-- That prevents backfilling existing rows with the new columns and prevents
-- newer printings from getting their metadata refreshed if Scryfall corrects
-- it. card_prints is world-readable shared reference data; allow authenticated
-- users to update existing rows so the client-side enrichment path can fill
-- missing fields collectively. Immutable identity columns (scryfall_id, id,
-- created_at) are protected by the WITH CHECK clause.

drop policy if exists "authenticated update card_prints" on public.card_prints;
create policy "authenticated update card_prints"
  on public.card_prints
  for update
  to authenticated
  using (true)
  with check (true);

grant update on public.card_prints to authenticated;

-- Block client tampering with identity / audit columns at the trigger level so
-- the permissive UPDATE policy above cannot be used to rewrite a print's
-- scryfall_id or forge created_at.
create or replace function public.card_prints_protect_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.id          := old.id;
  new.scryfall_id := old.scryfall_id;
  new.created_at  := old.created_at;
  new.updated_at  := now();
  return new;
end;
$$;

drop trigger if exists card_prints_protect_identity on public.card_prints;
create trigger card_prints_protect_identity
  before update on public.card_prints
  for each row
  execute function public.card_prints_protect_identity();
