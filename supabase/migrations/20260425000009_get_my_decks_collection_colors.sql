-- Fix get_my_decks: collection decks store cards in deck_allocations (not deck_cards),
-- so aggregate color identity from both sources via UNION.

create or replace function get_my_decks(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  select jsonb_agg(
    jsonb_build_object(
      'id',                  f.id,
      'name',                f.name,
      'description',         f.description,
      'type',                f.type,
      'user_id',             f.user_id,
      'created_at',          f.created_at,
      'updated_at',          f.updated_at,
      'deck_color_identity', (
        select jsonb_agg(distinct ci order by ci)
        from (
          -- builder deck cards
          select unnest(dc.color_identity) as ci
          from deck_cards dc
          where dc.deck_id = f.id
          union
          -- collection deck allocations → card_prints
          select unnest(cp.color_identity) as ci
          from deck_allocations da
          join cards c   on c.id  = da.card_id
          join card_prints cp on cp.id = c.card_print_id
          where da.deck_id = f.id
        ) colors
        where ci in ('W','U','B','R','G','C')
      )
    )
    order by f.updated_at desc
  ) into v_result
  from folders f
  where f.user_id = p_user_id
    and f.type in ('builder_deck', 'deck');

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

grant execute on function get_my_decks(uuid) to authenticated;
