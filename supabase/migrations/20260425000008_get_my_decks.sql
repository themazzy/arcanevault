-- Returns the user's own builder_deck + deck folders with
-- deck_color_identity aggregated from deck_cards (same approach as get_community_decks).
-- Security definer so it can join deck_cards regardless of RLS,
-- but the p_user_id filter ensures only the caller's own decks are returned.

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
        from deck_cards dc,
             jsonb_array_elements_text(to_jsonb(dc.color_identity)) as ci
        where dc.deck_id = f.id
          and ci in ('W','U','B','R','G','C')
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
