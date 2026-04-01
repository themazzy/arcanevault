create table if not exists public.card_prices (
  scryfall_id        text not null,
  set_code           text not null,
  collector_number   text not null,
  snapshot_date      date not null,
  price_regular_eur  numeric(10,2),
  price_foil_eur     numeric(10,2),
  price_regular_usd  numeric(10,2),
  price_foil_usd     numeric(10,2),
  updated_at         timestamptz not null default now(),
  primary key (scryfall_id, snapshot_date)
);

create index if not exists card_prices_snapshot_date_idx
  on public.card_prices(snapshot_date);

create index if not exists card_prices_set_collector_snapshot_idx
  on public.card_prices(set_code, collector_number, snapshot_date);

alter table public.card_prices enable row level security;

create policy "public read card prices"
  on public.card_prices
  for select
  using (true);

grant select on public.card_prices to authenticated, anon;
