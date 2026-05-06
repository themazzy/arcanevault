create table if not exists public.deck_categories (
  id         uuid primary key default gen_random_uuid(),
  deck_id    uuid not null references public.folders(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0 and length(trim(name)) <= 64),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deck_categories_deck_id_idx
  on public.deck_categories(deck_id);

create index if not exists deck_categories_user_id_idx
  on public.deck_categories(user_id);

create index if not exists deck_categories_deck_sort_idx
  on public.deck_categories(deck_id, sort_order);

create unique index if not exists deck_categories_deck_name_unique_idx
  on public.deck_categories(deck_id, lower(trim(name)));

alter table public.deck_categories enable row level security;

drop policy if exists "Users manage own deck_categories" on public.deck_categories;
create policy "Users manage own deck_categories"
  on public.deck_categories
  for all
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.folders f
      where f.id = deck_categories.deck_id
        and f.user_id = (select auth.uid())
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.folders f
      where f.id = deck_categories.deck_id
        and f.user_id = (select auth.uid())
    )
  );

grant all on public.deck_categories to authenticated;
revoke all on public.deck_categories from anon;

drop trigger if exists deck_categories_updated_at on public.deck_categories;
create trigger deck_categories_updated_at
  before update on public.deck_categories
  for each row execute function public.update_updated_at();

alter table public.deck_cards
  add column if not exists category_id uuid references public.deck_categories(id) on delete set null;

create index if not exists deck_cards_category_id_idx
  on public.deck_cards(category_id);

create or replace function public.validate_deck_card_category()
returns trigger
language plpgsql
as $$
begin
  if new.category_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.deck_categories dcg
    where dcg.id = new.category_id
      and dcg.deck_id = new.deck_id
      and dcg.user_id = new.user_id
  ) then
    raise exception 'deck card category must belong to the same deck and user';
  end if;

  return new;
end;
$$;

drop trigger if exists deck_cards_validate_category on public.deck_cards;
create trigger deck_cards_validate_category
  before insert or update of category_id, deck_id, user_id on public.deck_cards
  for each row execute function public.validate_deck_card_category();

create or replace view public.deck_cards_view as
select
  dc.id,
  dc.deck_id,
  dc.user_id,
  dc.card_print_id,
  coalesce(cp.scryfall_id, dc.scryfall_id) as scryfall_id,
  coalesce(cp.name, dc.name) as name,
  coalesce(cp.set_code, dc.set_code) as set_code,
  coalesce(cp.collector_number, dc.collector_number) as collector_number,
  coalesce(cp.type_line, dc.type_line) as type_line,
  coalesce(cp.mana_cost, dc.mana_cost) as mana_cost,
  coalesce(cp.cmc, dc.cmc) as cmc,
  case
    when coalesce(array_length(cp.color_identity, 1), 0) > 0 then cp.color_identity
    else coalesce(dc.color_identity, '{}'::text[])
  end as color_identity,
  coalesce(cp.image_uri, dc.image_uri) as image_uri,
  cp.art_crop_uri,
  dc.qty,
  dc.foil,
  dc.is_commander,
  dc.board,
  dc.category_id,
  dc.created_at,
  dc.updated_at
from public.deck_cards dc
left join public.card_prints cp on cp.id = dc.card_print_id;

alter view public.deck_cards_view set (security_invoker = true);
revoke all on public.deck_cards_view from anon;
grant select on public.deck_cards_view to authenticated;
