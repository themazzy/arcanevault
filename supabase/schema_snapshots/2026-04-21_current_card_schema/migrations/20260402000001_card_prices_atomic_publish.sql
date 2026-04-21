create table if not exists public.card_prices_stage (
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

create index if not exists card_prices_stage_snapshot_date_idx
  on public.card_prices_stage(snapshot_date);

create index if not exists card_prices_stage_set_collector_snapshot_idx
  on public.card_prices_stage(set_code, collector_number, snapshot_date);

create or replace function public.publish_card_prices(p_snapshot_date date, p_retention_cutoff date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.card_prices
  where snapshot_date = p_snapshot_date;

  insert into public.card_prices (
    scryfall_id,
    set_code,
    collector_number,
    snapshot_date,
    price_regular_eur,
    price_foil_eur,
    price_regular_usd,
    price_foil_usd,
    updated_at
  )
  select
    scryfall_id,
    set_code,
    collector_number,
    snapshot_date,
    price_regular_eur,
    price_foil_eur,
    price_regular_usd,
    price_foil_usd,
    updated_at
  from public.card_prices_stage
  where snapshot_date = p_snapshot_date;

  delete from public.card_prices
  where snapshot_date < p_retention_cutoff;

  delete from public.card_prices_stage
  where snapshot_date = p_snapshot_date;
end;
$$;
