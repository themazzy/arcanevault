-- ArcaneVault repair script for legacy unresolved deck_cards
--
-- Problem:
-- Some older deck_cards rows have:
-- - null scryfall_id
-- - null card_print_id
-- - print info embedded in name, e.g.:
--   "Big ScoreSNC-102"
--   "Goblin OffensiveUSG-192"
--   "Archmage Emeritus *F*"
--
-- This script:
-- 1. finds unresolved rows
-- 2. normalizes legacy names
-- 3. auto-matches safe candidates
-- 4. updates deck_cards in place
-- 5. shows what still needs manual attention
--
-- Safe matching rules:
-- - if set_code + collector_number can be parsed, match by those fields
-- - otherwise only match by normalized name when that name is unique in card_prints
--
-- Recommended:
-- Run this in SQL Editor.
-- Review the preview sections before running the UPDATE section.

-- 1. Baseline count
select
  count(*) as unresolved_before
from public.deck_cards
where card_print_id is null
  and scryfall_id is null;

-- 2. Preview parsing
with unresolved as (
  select
    dc.id,
    dc.deck_id,
    dc.user_id,
    dc.name as raw_name,
    dc.foil as raw_foil,
    dc.qty,
    dc.created_at,
    regexp_replace(dc.name, '\s*\*F\*\s*$', '', 'i') as name_without_foil,
    (dc.name ~* '\s*\*F\*\s*$') as parsed_foil
  from public.deck_cards dc
  where dc.card_print_id is null
    and dc.scryfall_id is null
),
parsed as (
  select
    u.*,
    case
      when u.name_without_foil ~ '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$'
      then regexp_replace(u.name_without_foil, '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$', '')
      else u.name_without_foil
    end as candidate_name,
    case
      when u.name_without_foil ~ '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$'
      then substring(u.name_without_foil from '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$')
      else null
    end as parsed_suffix
  from unresolved u
),
normalized as (
  select
    p.*,
    trim(p.candidate_name) as normalized_name,
    case
      when p.parsed_suffix is not null
      then substring(p.parsed_suffix from '^([A-Z0-9]{2,6})-')
      else null
    end as parsed_set_code,
    case
      when p.parsed_suffix is not null
      then substring(p.parsed_suffix from '^[A-Z0-9]{2,6}-([0-9]{1,4}[A-Z]?)$')
      else null
    end as parsed_collector_number
  from parsed p
)
select
  id,
  raw_name,
  normalized_name,
  parsed_set_code,
  parsed_collector_number,
  raw_foil,
  parsed_foil,
  qty,
  created_at
from normalized
order by created_at, raw_name;

-- 3. Preview safe auto-matches
with unresolved as (
  select
    dc.id,
    dc.deck_id,
    dc.user_id,
    dc.name as raw_name,
    dc.foil as raw_foil,
    regexp_replace(dc.name, '\s*\*F\*\s*$', '', 'i') as name_without_foil,
    (dc.name ~* '\s*\*F\*\s*$') as parsed_foil
  from public.deck_cards dc
  where dc.card_print_id is null
    and dc.scryfall_id is null
),
normalized as (
  select
    u.*,
    trim(
      case
        when u.name_without_foil ~ '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$'
        then regexp_replace(u.name_without_foil, '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$', '')
        else u.name_without_foil
      end
    ) as normalized_name,
    case
      when u.name_without_foil ~ '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$'
      then substring(u.name_without_foil from '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$')
      else null
    end as parsed_suffix
  from unresolved u
),
expanded as (
  select
    n.*,
    case
      when n.parsed_suffix is not null
      then substring(n.parsed_suffix from '^([A-Z0-9]{2,6})-')
      else null
    end as parsed_set_code,
    case
      when n.parsed_suffix is not null
      then substring(n.parsed_suffix from '^[A-Z0-9]{2,6}-([0-9]{1,4}[A-Z]?)$')
      else null
    end as parsed_collector_number
  from normalized n
),
name_uniques as (
  select
    name,
    count(*) as name_count,
    min(id::text)::uuid as only_id
  from public.card_prints
  group by name
),
candidates as (
  select
    e.id as deck_card_id,
    e.raw_name,
    e.normalized_name,
    e.raw_foil,
    e.parsed_foil,
    e.parsed_set_code,
    e.parsed_collector_number,
    cp.id as card_print_id,
    cp.scryfall_id,
    cp.name as matched_name,
    cp.set_code as matched_set_code,
    cp.collector_number as matched_collector_number,
    case
      when e.parsed_set_code is not null and e.parsed_collector_number is not null then 'set+collector'
      else 'unique_name'
    end as match_strategy
  from expanded e
  join public.card_prints cp
    on (
      e.parsed_set_code is not null
      and e.parsed_collector_number is not null
      and cp.set_code = e.parsed_set_code
      and cp.collector_number = e.parsed_collector_number
    )
    or (
      e.parsed_set_code is null
      and cp.name = e.normalized_name
      and exists (
        select 1
        from name_uniques nu
        where nu.name = e.normalized_name
          and nu.name_count = 1
          and nu.only_id = cp.id
      )
    )
)
select
  deck_card_id,
  raw_name,
  normalized_name,
  parsed_set_code,
  parsed_collector_number,
  matched_name,
  matched_set_code,
  matched_collector_number,
  scryfall_id,
  match_strategy,
  raw_foil,
  parsed_foil
from candidates
order by raw_name;

-- 4. Apply auto-fix
with unresolved as (
  select
    dc.id,
    dc.name as raw_name,
    dc.foil as raw_foil,
    regexp_replace(dc.name, '\s*\*F\*\s*$', '', 'i') as name_without_foil,
    (dc.name ~* '\s*\*F\*\s*$') as parsed_foil
  from public.deck_cards dc
  where dc.card_print_id is null
    and dc.scryfall_id is null
),
normalized as (
  select
    u.*,
    trim(
      case
        when u.name_without_foil ~ '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$'
        then regexp_replace(u.name_without_foil, '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$', '')
        else u.name_without_foil
      end
    ) as normalized_name,
    case
      when u.name_without_foil ~ '([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$'
      then substring(u.name_without_foil from '^.*?([A-Z0-9]{2,6})-([0-9]{1,4}[A-Z]?)$')
      else null
    end as parsed_suffix
  from unresolved u
),
expanded as (
  select
    n.*,
    case
      when n.parsed_suffix is not null
      then substring(n.parsed_suffix from '^([A-Z0-9]{2,6})-')
      else null
    end as parsed_set_code,
    case
      when n.parsed_suffix is not null
      then substring(n.parsed_suffix from '^[A-Z0-9]{2,6}-([0-9]{1,4}[A-Z]?)$')
      else null
    end as parsed_collector_number
  from normalized n
),
name_uniques as (
  select
    name,
    count(*) as name_count,
    min(id::text)::uuid as only_id
  from public.card_prints
  group by name
),
resolved as (
  select
    e.id as deck_card_id,
    e.normalized_name,
    coalesce(e.raw_foil, false) or e.parsed_foil as resolved_foil,
    cp.id as card_print_id,
    cp.scryfall_id,
    cp.set_code,
    cp.collector_number,
    cp.type_line,
    cp.mana_cost,
    cp.cmc,
    cp.color_identity,
    cp.image_uri
  from expanded e
  join public.card_prints cp
    on (
      e.parsed_set_code is not null
      and e.parsed_collector_number is not null
      and cp.set_code = e.parsed_set_code
      and cp.collector_number = e.parsed_collector_number
    )
    or (
      e.parsed_set_code is null
      and cp.name = e.normalized_name
      and exists (
        select 1
        from name_uniques nu
        where nu.name = e.normalized_name
          and nu.name_count = 1
          and nu.only_id = cp.id
      )
    )
)
update public.deck_cards dc
set
  card_print_id = r.card_print_id,
  scryfall_id = r.scryfall_id,
  name = r.normalized_name,
  set_code = r.set_code,
  collector_number = r.collector_number,
  type_line = coalesce(dc.type_line, r.type_line),
  mana_cost = coalesce(dc.mana_cost, r.mana_cost),
  cmc = coalesce(dc.cmc, r.cmc),
  color_identity = case
    when coalesce(array_length(dc.color_identity, 1), 0) > 0 then dc.color_identity
    else coalesce(r.color_identity, '{}'::text[])
  end,
  image_uri = coalesce(dc.image_uri, r.image_uri),
  foil = r.resolved_foil,
  updated_at = now()
from resolved r
where dc.id = r.deck_card_id;

-- 5. Results summary
select
  count(*) as unresolved_after
from public.deck_cards
where card_print_id is null
  and scryfall_id is null;

-- 6. Remaining unresolved rows for manual cleanup
select
  id,
  deck_id,
  user_id,
  name,
  qty,
  foil,
  created_at,
  updated_at
from public.deck_cards
where card_print_id is null
  and scryfall_id is null
order by created_at, name;
