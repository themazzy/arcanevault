-- Expose a single user's nickname to any authenticated caller (RLS bypass).
create or replace function get_user_nickname(p_user_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select nickname from user_settings where user_id = p_user_id limit 1;
$$;
grant execute on function get_user_nickname(uuid) to authenticated, anon;

-- Rebuild get_public_decks to also return deck meta (commander, colors, format, art).
drop function if exists get_public_decks(uuid);
create or replace function get_public_decks(p_user_id uuid)
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
      'id',         f.id,
      'name',       f.name,
      'type',       f.type,
      'card_count',
        case f.type
          when 'builder_deck' then (
            select coalesce(sum(dc.qty), 0) from deck_cards dc where dc.deck_id = f.id
          )
          else (
            select coalesce(sum(da.qty), 0) from deck_allocations da where da.deck_id = f.id
          )
        end,
      'commander_name',        (f.description::jsonb)->>'commanderName',
      'commander_scryfall_id', (f.description::jsonb)->>'commanderScryfallId',
      'color_identity',        (f.description::jsonb)->'commanderColorIdentity',
      'format',                (f.description::jsonb)->>'format',
      'cover_art_uri',         (f.description::jsonb)->>'coverArtUri'
    )
    order by f.created_at desc
  ) into v_result
  from folders f
  where f.user_id = p_user_id
    and f.type in ('deck', 'builder_deck')
    and not (
      f.type = 'deck'
      and f.description is not null
      and (f.description::jsonb->>'linked_builder_id') is not null
      and (f.description::jsonb->>'linked_builder_id') != ''
    );

  return coalesce(v_result, '[]'::jsonb);
end;
$$;
grant execute on function get_public_decks(uuid) to anon, authenticated;
