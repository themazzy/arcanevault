-- Extend get_community_decks to include aggregate deck color identity
-- computed from deck_cards (for builder_deck type) rather than relying solely
-- on commander color identity stored in folder metadata.

create or replace function get_community_decks()
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
      'id',                 f.id,
      'name',               f.name,
      'description',        f.description,
      'user_id',            f.user_id,
      'updated_at',         f.updated_at,
      'type',               f.type,
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
  where f.type in ('builder_deck', 'deck')
    and (f.description::jsonb)->>'is_public' = 'true'
    and not (
      f.type = 'deck'
      and (f.description::jsonb)->>'linked_builder_id' is not null
      and (f.description::jsonb)->>'linked_builder_id' != ''
    );

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

grant execute on function get_community_decks() to anon, authenticated;
