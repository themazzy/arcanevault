-- DeckBuilder edits deck_cards for both builder decks and standalone collection
-- decks. Count those persisted card changes as meaningful deck modifications.
create or replace function public.mark_decks_modified_on_card_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  update public.folders f
  set deck_modified_at = now()
  where f.id in (
    select distinct deck_id
    from new_rows
    where deck_id is not null
  )
    and (
      (tg_table_name = 'deck_cards' and f.type in ('builder_deck', 'deck'))
      or (tg_table_name = 'deck_allocations' and f.type = 'deck')
    );

  return null;
end;
$function$;

create or replace function public.mark_decks_modified_on_card_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  update public.folders f
  set deck_modified_at = now()
  where f.id in (
    select distinct deck_id
    from old_rows
    where deck_id is not null
  )
    and (
      (tg_table_name = 'deck_cards' and f.type in ('builder_deck', 'deck'))
      or (tg_table_name = 'deck_allocations' and f.type = 'deck')
    );

  return null;
end;
$function$;

create or replace function public.mark_decks_modified_on_card_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  update public.folders f
  set deck_modified_at = now()
  where f.id in (
    select distinct changed.deck_id
    from (
      select o.deck_id
      from old_rows o
      full join new_rows n using (id)
      where (to_jsonb(o) - array['created_at', 'updated_at'])
        is distinct from
        (to_jsonb(n) - array['created_at', 'updated_at'])

      union

      select n.deck_id
      from old_rows o
      full join new_rows n using (id)
      where (to_jsonb(o) - array['created_at', 'updated_at'])
        is distinct from
        (to_jsonb(n) - array['created_at', 'updated_at'])
    ) changed
    where changed.deck_id is not null
  )
    and (
      (tg_table_name = 'deck_cards' and f.type in ('builder_deck', 'deck'))
      or (tg_table_name = 'deck_allocations' and f.type = 'deck')
    );

  return null;
end;
$function$;

revoke all on function public.mark_decks_modified_on_card_insert() from public, anon, authenticated;
revoke all on function public.mark_decks_modified_on_card_delete() from public, anon, authenticated;
revoke all on function public.mark_decks_modified_on_card_update() from public, anon, authenticated;
