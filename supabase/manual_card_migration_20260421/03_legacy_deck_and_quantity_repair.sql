-- Chunk 03: move legacy deck folder_cards, add deck-folder guard, repair placement quantity mismatches
-- Run after the previous numbered chunk completes successfully.

insert into public.deck_allocations (deck_id, user_id, card_id, qty)
select fc.folder_id, f.user_id, fc.card_id, fc.qty
from public.folder_cards fc
join public.folders f on f.id = fc.folder_id
where f.type = 'deck'
on conflict (deck_id, card_id) do update
set qty = greatest(public.deck_allocations.qty, excluded.qty),
    updated_at = now();

delete from public.folder_cards fc
using public.folders f
where f.id = fc.folder_id
  and f.type = 'deck';

create or replace function public.prevent_deck_folder_cards()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.folders
    where id = new.folder_id
      and type = 'deck'
  ) then
    raise exception 'folder_cards cannot reference folders of type deck';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_deck_folder_cards_trigger on public.folder_cards;
create trigger prevent_deck_folder_cards_trigger
  before insert or update of folder_id on public.folder_cards
  for each row execute function public.prevent_deck_folder_cards();

with placement_totals as (
  select c.id as card_id, c.user_id, c.qty as owned_qty,
         coalesce(fc.qty, 0) + coalesce(da.qty, 0) as placement_qty
  from public.cards c
  left join (
    select card_id, sum(qty) as qty
    from public.folder_cards
    group by card_id
  ) fc on fc.card_id = c.id
  left join (
    select card_id, sum(qty) as qty
    from public.deck_allocations
    group by card_id
  ) da on da.card_id = c.id
),
missing as (
  select card_id, user_id, owned_qty - placement_qty as missing_qty
  from placement_totals
  where owned_qty > placement_qty
),
unsorted as (
  insert into public.folders (user_id, name, type)
  select distinct user_id, 'Unsorted', 'binder'
  from missing
  on conflict (user_id, name, type) do update
  set updated_at = now()
  returning id, user_id
)
insert into public.folder_cards (folder_id, card_id, qty)
select u.id, m.card_id, m.missing_qty
from missing m
join unsorted u on u.user_id = m.user_id
where m.missing_qty > 0
on conflict (folder_id, card_id) do update
set qty = public.folder_cards.qty + excluded.qty,
    updated_at = now();

with placement_totals as (
  select c.id as card_id, coalesce(fc.qty, 0) + coalesce(da.qty, 0) as placement_qty
  from public.cards c
  left join (
    select card_id, sum(qty) as qty
    from public.folder_cards
    group by card_id
  ) fc on fc.card_id = c.id
  left join (
    select card_id, sum(qty) as qty
    from public.deck_allocations
    group by card_id
  ) da on da.card_id = c.id
)
update public.cards c
set qty = pt.placement_qty,
    updated_at = now()
from placement_totals pt
where pt.card_id = c.id
  and pt.placement_qty > c.qty;
