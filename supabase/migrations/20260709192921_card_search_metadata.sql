-- Serve name-based card search from our own tables instead of Scryfall
-- (AddCardModal, scanner manual add, Trading want-list, Home autocomplete).
--
-- card_prints gains print-level sort/identity columns kept fresh by the daily
-- price sync (which already streams Scryfall's all_cards bulk export);
-- trigram indexes make substring name search index-backed; the RPC returns
-- ranked one-row-per-card matches from oracle_cards.

create extension if not exists pg_trgm with schema extensions;

alter table public.card_prints
  add column if not exists released_at date,
  add column if not exists edhrec_rank integer,
  add column if not exists illustration_id text,
  add column if not exists finishes text[] not null default '{}'::text[];

-- Substring + fuzzy name search on both tables (ILIKE '%term%' / similarity).
create index if not exists card_prints_name_trgm_idx
  on public.card_prints using gin (name extensions.gin_trgm_ops);

create index if not exists oracle_cards_name_trgm_idx
  on public.oracle_cards using gin (name extensions.gin_trgm_ops);

-- Printings picker: all prints of an exact name, newest first. Supersedes the
-- plain name btree index (equality lookups use the composite's leading column).
create index if not exists card_prints_name_released_idx
  on public.card_prints (name, released_at desc nulls last);

drop index if exists public.card_prints_name_idx;

-- Ranked card-name search: one row per card (oracle identity), exact matches
-- first, then prefix matches, then trigram similarity. face_names lets DFC
-- front-face names hit. Excludes non-playable oracle rows (tokens, emblems,
-- art series, vanguard/scheme/plane extras) the way Scryfall's default search
-- mode does. SECURITY INVOKER: oracle_cards is public-read via RLS.
create or replace function public.search_card_names(
  search_term text,
  max_results integer default 20
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
  limit greatest(1, least(coalesce(max_results, 20), 50))
$$;

grant execute on function public.search_card_names(text, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';
