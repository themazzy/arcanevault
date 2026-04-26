-- Public deck URLs should only expose decks intentionally marked public.
-- Owners can still view their own private decks while signed in.

drop policy if exists "Public read deck folders" on public.folders;
create policy "Public read public deck folders"
  on public.folders for select
  using (
    type in ('deck', 'builder_deck')
    and public.safe_jsonb(description)->>'is_public' = 'true'
  );

create or replace function get_deck_cards_for_view(p_deck_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not exists (
    select 1
    from folders f
    where f.id = p_deck_id
      and f.type in ('deck', 'builder_deck')
      and (
        f.user_id = auth.uid()
        or public.safe_jsonb(f.description)->>'is_public' = 'true'
      )
  ) then
    return '[]'::jsonb;
  end if;

  -- Try deck_cards first (builder decks; also hydrated collection decks)
  select jsonb_agg(row_to_json(v)::jsonb order by v.is_commander desc, v.name)
  into v_result
  from deck_cards_view v
  where v.deck_id = p_deck_id;

  if v_result is not null and jsonb_array_length(v_result) > 0 then
    return v_result;
  end if;

  -- Fallback: read allocations directly (collection decks not yet hydrated).
  -- Bypasses the RLS on `cards` that blocks non-owners.
  select jsonb_agg(
    jsonb_build_object(
      'id',               da.id,
      'deck_id',          da.deck_id,
      'user_id',          da.user_id,
      'card_print_id',    c.card_print_id,
      'scryfall_id',      coalesce(cp.scryfall_id, c.scryfall_id),
      'name',             coalesce(cp.name, c.name),
      'set_code',         coalesce(cp.set_code, c.set_code),
      'collector_number', coalesce(cp.collector_number, c.collector_number),
      'type_line',        cp.type_line,
      'mana_cost',        cp.mana_cost,
      'cmc',              cp.cmc,
      'color_identity',   coalesce(cp.color_identity, '{}'),
      'image_uri',        cp.image_uri,
      'art_crop_uri',     cp.art_crop_uri,
      'qty',              da.qty,
      'foil',             c.foil,
      'is_commander',     false,
      'board',            'main',
      'created_at',       da.created_at,
      'updated_at',       da.updated_at
    )
    order by coalesce(cp.name, c.name)
  ) into v_result
  from deck_allocations da
  join cards c  on c.id  = da.card_id
  left join card_prints cp on cp.id = c.card_print_id
  where da.deck_id = p_deck_id;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

grant execute on function get_deck_cards_for_view(uuid) to anon, authenticated;
