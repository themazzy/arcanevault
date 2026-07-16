-- A linked builder/collection pair is presented as one logical deck, but card
-- edits happen on different physical folders: deck_cards touches the builder
-- side while deck_allocations touches the collection side. Keep the meaningful
-- recency timestamp aligned so whichever side an index renders moves together.

create or replace function public.propagate_linked_deck_modified_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if new.type not in ('builder_deck', 'deck')
     or new.deck_modified_at is not distinct from old.deck_modified_at then
    return null;
  end if;

  update public.folders pair
  set deck_modified_at = new.deck_modified_at
  where pair.user_id = new.user_id
    and pair.id <> new.id
    and pair.type in ('builder_deck', 'deck')
    and pair.deck_modified_at < new.deck_modified_at
    and (
      pair.id::text = nullif(public.safe_jsonb(new.description)->>'linked_deck_id', '')
      or pair.id::text = nullif(public.safe_jsonb(new.description)->>'linked_builder_id', '')
      or public.safe_jsonb(pair.description)->>'linked_deck_id' = new.id::text
      or public.safe_jsonb(pair.description)->>'linked_builder_id' = new.id::text
    );

  return null;
end;
$function$;

revoke all on function public.propagate_linked_deck_modified_at() from public, anon, authenticated;

-- Reconcile pairs that diverged before propagation existed. Either direction
-- is accepted so legacy one-sided link metadata is repaired too.
with linked_pairs as (
  select
    b.id as builder_id,
    c.id as collection_id,
    greatest(b.deck_modified_at, c.deck_modified_at) as pair_modified_at
  from public.folders b
  join public.folders c
    on c.user_id = b.user_id
   and c.type = 'deck'
   and (
     c.id::text = nullif(public.safe_jsonb(b.description)->>'linked_deck_id', '')
     or public.safe_jsonb(c.description)->>'linked_builder_id' = b.id::text
   )
  where b.type = 'builder_deck'
), pair_rows as (
  select builder_id as id, pair_modified_at from linked_pairs
  union all
  select collection_id as id, pair_modified_at from linked_pairs
)
update public.folders f
set deck_modified_at = pair_rows.pair_modified_at
from pair_rows
where f.id = pair_rows.id
  and f.deck_modified_at is distinct from pair_rows.pair_modified_at;

drop trigger if exists folders_propagate_linked_deck_recency on public.folders;
create trigger folders_propagate_linked_deck_recency
  after update of deck_modified_at on public.folders
  for each row execute function public.propagate_linked_deck_modified_at();
