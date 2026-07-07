-- Restores get_deck_og_meta (dropped in 20260611120000 along with the og-deck
-- edge function) to feed the Cloudflare Worker that now serves Open Graph
-- previews on the branded deckloom.app/d/<id> URL instead.
--
-- Lightweight metadata fetch for social-share (Open Graph) previews.
-- Used by the `deckloom-og` Cloudflare Worker (cloudflare/og-worker), called
-- with the anon key.
-- SECURITY DEFINER so it can read folder/card data, but it returns NULL for
-- any deck that is not explicitly public — anon callers must never be able to
-- pull metadata for a private deck.
create or replace function public.get_deck_og_meta(p_deck_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id        uuid;
  v_name           text;
  v_meta           jsonb;
  v_format         text;
  v_commander      text;
  v_total          int;
  v_art            text;
  v_nick           text;
begin
  select f.user_id, f.name, public.safe_jsonb(f.description)
    into v_user_id, v_name, v_meta
  from public.folders f
  where f.id = p_deck_id;

  -- Not found, or not public: expose nothing.
  if v_user_id is null then
    return null;
  end if;
  if coalesce(v_meta->>'is_public', 'false') <> 'true' then
    return null;
  end if;

  v_format := nullif(v_meta->>'format', '');

  -- Commander name(s): prefer the meta blob, fall back to flagged deck cards.
  v_commander := nullif(
    coalesce(
      (select string_agg(c->>'name', ' + ')
         from jsonb_array_elements(coalesce(v_meta->'commanders', '[]'::jsonb)) c
        where coalesce(c->>'name', '') <> ''),
      v_meta->>'commanderName'
    ), '');

  -- Card count + representative art from builder cards (deck_cards).
  -- Prefer commander art, then highest mana value, then name — gives a
  -- recognisable, "splashy" image for the preview.
  select coalesce(sum(dc.qty), 0),
         (array_agg(coalesce(cp.art_crop_uri, cp.image_uri)
                      order by dc.is_commander desc, cp.cmc desc nulls last, cp.name)
            filter (where coalesce(cp.art_crop_uri, cp.image_uri) is not null))[1]
    into v_total, v_art
  from public.deck_cards dc
  left join public.card_prints cp on cp.id = dc.card_print_id
  where dc.deck_id = p_deck_id;

  if v_commander is null then
    select string_agg(cp.name, ' + ')
      into v_commander
    from public.deck_cards dc
    join public.card_prints cp on cp.id = dc.card_print_id
    where dc.deck_id = p_deck_id and dc.is_commander;
    v_commander := nullif(v_commander, '');
  end if;

  -- Collection decks store owned cards in deck_allocations, not deck_cards.
  -- Fall back to those for count/art so public collection decks preview too.
  if coalesce(v_total, 0) = 0 then
    select coalesce(sum(da.qty), 0),
           (array_agg(coalesce(cp.art_crop_uri, cp.image_uri) order by cp.cmc desc nulls last, cp.name)
              filter (where coalesce(cp.art_crop_uri, cp.image_uri) is not null))[1]
      into v_total, v_art
    from public.deck_allocations da
    join public.cards c on c.id = da.card_id
    join public.card_prints cp on cp.id = c.card_print_id
    where da.deck_id = p_deck_id;
  end if;

  begin
    v_nick := public.get_user_nickname(v_user_id);
  exception when others then
    v_nick := null;
  end;

  return jsonb_build_object(
    'name',        v_name,
    'format',      v_format,
    'commander',   v_commander,
    'total_cards', coalesce(v_total, 0),
    'art',         v_art,
    'creator',     nullif(v_nick, '')
  );
end;
$function$;

-- Public-schema GRANTs must be explicit (new-table auto-exposure is being
-- turned off platform-wide); this RPC is intentionally callable anonymously.
grant execute on function public.get_deck_og_meta(uuid) to anon, authenticated;
