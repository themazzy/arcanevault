-- Paginated, one-result-per-card search for the DeckBuilder Add Cards panel.
-- Search stays on our weekly-synced oracle_cards catalogue; requesting one
-- extra row lets the client determine whether another page exists.
create or replace function public.search_deck_builder_cards(
  search_term text,
  page_size integer default 41,
  page_offset integer default 0
)
returns setof public.oracle_cards
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with input as (
    select
      trim(coalesce(search_term, '')) as raw,
      '%' || replace(replace(replace(trim(coalesce(search_term, '')),
        '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern,
      replace(replace(replace(trim(coalesce(search_term, '')),
        '\', '\\'), '%', '\%'), '_', '\_') || '%' as prefix_pattern
  )
  select oc.*
  from public.oracle_cards oc, input i
  where length(i.raw) >= 2
    and (
      oc.name ilike i.pattern
      or oc.name % i.raw
      or exists (
        select 1 from unnest(oc.face_names) fn where fn ilike i.pattern
      )
    )
    and coalesce(oc.type_line, '') not ilike 'token%'
    and coalesce(oc.type_line, '') not ilike 'emblem%'
    and coalesce(oc.type_line, '') not ilike 'card%'
    and coalesce(oc.type_line, '') not ilike 'vanguard%'
    and coalesce(oc.type_line, '') not ilike 'scheme%'
    and coalesce(oc.type_line, '') not ilike 'ongoing scheme%'
    and coalesce(oc.type_line, '') not ilike 'plane %'
    and coalesce(oc.type_line, '') not ilike 'phenomenon%'
    and coalesce(oc.type_line, '') not ilike 'sticker%'
  order by
    (lower(oc.name) = lower(i.raw)) desc,
    (oc.name ilike i.prefix_pattern) desc,
    similarity(oc.name, i.raw) desc,
    oc.name asc
  limit greatest(1, least(coalesce(page_size, 41), 51))
  offset greatest(0, coalesce(page_offset, 0))
$$;

grant execute on function public.search_deck_builder_cards(text, integer, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';
