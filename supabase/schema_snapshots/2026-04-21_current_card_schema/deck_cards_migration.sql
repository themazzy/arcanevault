-- ArcaneVault: Deck Builder migration
-- Run this in the Supabase SQL editor (Dashboard > SQL Editor)
-- Date: 2026-03-18

create table if not exists public.deck_cards (
  id               uuid primary key default gen_random_uuid(),
  deck_id          uuid not null references public.folders(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  scryfall_id      text,
  name             text not null,
  set_code         text,
  collector_number text,
  type_line        text,
  mana_cost        text,
  cmc              numeric,
  color_identity   text[] default '{}',
  image_uri        text,
  qty              integer not null default 1,
  foil             boolean not null default false,
  is_commander     boolean not null default false,
  board            text not null default 'main' check (board in ('main','side','maybe')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists deck_cards_deck_id_idx on public.deck_cards(deck_id);
create index if not exists deck_cards_user_id_idx on public.deck_cards(user_id);
create index if not exists deck_cards_scryfall_id_idx on public.deck_cards(scryfall_id);

alter table public.deck_cards enable row level security;

create policy "Users manage own deck_cards"
  on public.deck_cards for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
