-- Card-art search for the "background art" pickers (binders, wishlists, profile
-- header). These used to hit api.scryfall.com/cards/search?unique=art directly,
-- which had two problems:
--   1. Double-faced cards were invisible. Scryfall puts image_uris on each face
--      (not at the top level) for DFCs, and every picker filtered results on
--      `c.image_uris?.art_crop`, so transform/MDFC cards silently vanished.
--   2. A name with no matches made Scryfall answer 404, which the browser logs
--      as a failed request in the console on every keystroke of a typo.
--
-- card_prints already stores art_crop_uri for 100% of English paper prints plus
-- per-face image URIs in card_faces, so the whole thing can be served from here.
-- Returns one row per distinct artwork (illustration_id), with true double-faced
-- prints contributing a second row for the back-face art.

create or replace function public.search_card_art(
  search_term text,
  max_results integer default 24
)
returns table (
  scryfall_id text,
  card_name text,
  face_name text,
  face_index integer,
  set_code text,
  set_name text,
  collector_number text,
  artist text,
  art_crop_uri text,
  released_at date
)
language sql
stable
set search_path to 'public', 'extensions'
as $$
  with input as (
    select
      trim(coalesce(search_term, '')) as raw,
      '%' || replace(replace(replace(trim(coalesce(search_term, '')),
        '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern,
      replace(replace(replace(trim(coalesce(search_term, '')),
        '\', '\\'), '%', '\%'), '_', '\_') || '%' as prefix_pattern
  ),
  matched as (
    select
      p.scryfall_id,
      p.name,
      p.set_code,
      p.set_name,
      p.collector_number,
      p.artist,
      p.art_crop_uri,
      p.released_at,
      coalesce(p.illustration_id, p.scryfall_id) as art_key,
      p.card_faces -> 0 ->> 'name' as front_face_name,
      p.card_faces -> 1 ->> 'name' as back_face_name,
      -- Split cards ("Fire // Ice") also carry two faces, but both share the one
      -- printed image and have no per-face image_uris. Only genuine two-sided
      -- prints have a back-face image, which is what gates the extra art row.
      p.card_faces -> 1 -> 'image_uris' ->> 'normal' as back_normal,
      case
        when lower(p.name) = lower(i.raw) then 0
        -- "Delver of Secrets" should rank as an exact hit for
        -- "Delver of Secrets // Insectile Aberration".
        when lower(split_part(p.name, ' // ', 1)) = lower(i.raw) then 0
        when p.name ilike i.prefix_pattern then 1
        else 2
      end as relevance
    from public.card_prints p, input i
    -- The trigram index needs three characters to produce candidates; below that
    -- ilike degrades to a seq scan over ~113k rows (measured: 3.4 s).
    where length(i.raw) >= 3
      -- lang='en' rather than "en or null": the 36 null-lang rows are a legacy
      -- batch of promos Scryfall has since deleted (no released_at, no
      -- illustration_id, and their image URLs 404). Every live print has a lang.
      and p.lang = 'en'
      and p.art_crop_uri is not null
      and p.name ilike i.pattern
    order by relevance, p.released_at desc nulls last
    limit 400
  ),
  faces as (
    select
      m.scryfall_id,
      m.name as card_name,
      coalesce(nullif(m.front_face_name, ''), m.name) as face_name,
      0 as face_index,
      m.set_code, m.set_name, m.collector_number, m.artist,
      m.art_crop_uri,
      m.released_at,
      m.relevance,
      m.art_key as dedupe_key
    from matched m
    union all
    select
      m.scryfall_id,
      m.name as card_name,
      coalesce(nullif(m.back_face_name, ''), m.name) as face_name,
      1 as face_index,
      m.set_code, m.set_name, m.collector_number, m.artist,
      -- Scryfall serves the back face's art crop on the same CDN path as its
      -- other tiers: /normal/back/<a>/<b>/<id>.jpg -> /art_crop/back/...
      replace(m.back_normal, '/normal/', '/art_crop/') as art_crop_uri,
      m.released_at,
      m.relevance,
      m.art_key || ':back' as dedupe_key
    from matched m
    where m.back_normal is not null
  ),
  ranked as (
    select
      f.*,
      row_number() over (
        partition by f.dedupe_key
        order by f.relevance, f.released_at desc nulls last, f.scryfall_id
      ) as rn
    from faces f
  )
  select
    r.scryfall_id,
    r.card_name,
    r.face_name,
    r.face_index,
    r.set_code,
    r.set_name,
    r.collector_number,
    r.artist,
    r.art_crop_uri,
    r.released_at
  from ranked r
  where r.rn = 1
  -- face_index sorts last so a two-sided print's front and back land next to
  -- each other. Ordering by it first would push every back face past the limit.
  order by r.relevance, r.released_at desc nulls last, r.card_name, r.scryfall_id, r.face_index
  limit greatest(1, least(coalesce(max_results, 24), 60));
$$;

grant execute on function public.search_card_art(text, integer) to anon, authenticated;
