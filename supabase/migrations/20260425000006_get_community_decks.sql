-- Replace the client-side ilike search (which only matched builder_deck type)
-- with a server-side function using proper JSONB operators.
-- Includes both builder_deck and deck types that are marked public,
-- deduplicating linked pairs (collection deck excluded when builder counterpart exists).

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
      'id',          f.id,
      'name',        f.name,
      'description', f.description,
      'user_id',     f.user_id,
      'updated_at',  f.updated_at
    )
    order by f.updated_at desc
  ) into v_result
  from folders f
  where f.type in ('builder_deck', 'deck')
    and (f.description::jsonb)->>'is_public' = 'true'
    -- exclude collection decks paired with a builder deck (avoid duplicates)
    and not (
      f.type = 'deck'
      and (f.description::jsonb)->>'linked_builder_id' is not null
      and (f.description::jsonb)->>'linked_builder_id' != ''
    );

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

grant execute on function get_community_decks() to anon, authenticated;
