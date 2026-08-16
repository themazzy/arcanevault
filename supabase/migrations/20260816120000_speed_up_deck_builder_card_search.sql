-- Make search_deck_builder_cards use the trigram indexes that already exist.
--
-- Measured 2026-08-16: the function was returning "canceling statement due to
-- statement timeout" on 3 of 7 consecutive anon calls for the term "bolt"
-- (4.2 s cold, 3.1 s worst warm) against a 3 s anon / 8 s authenticated
-- ceiling. EXPLAIN showed a Seq Scan over all 44,686 rows of the 94 MB
-- oracle_cards heap plus SubPlan `unnest` executed 35,011 times.
--
-- The cause was the shape of the predicate, not a missing index. The old body
-- filtered with a three-way OR:
--
--     oc.name ILIKE pattern
--     OR oc.name % raw
--     OR EXISTS (SELECT 1 FROM unnest(oc.face_names) fn WHERE fn ILIKE pattern)
--
-- The third branch is a correlated subquery, which the planner cannot fold
-- into a BitmapOr with the other two, so the whole disjunction fell back to a
-- sequential scan and every candidate index went unused — including
-- oracle_cards_face_trgm_idx, which had been built on
-- face_names_text(face_names) for exactly this predicate and was never once
-- reachable from it.
--
-- The fix splits the OR into a UNION of three separately-indexable branches
-- and joins the surviving oracle_ids back to the table. Each branch now gets
-- its own Bitmap Index Scan; shared buffers per search drop 12,011 -> 1,102.
--
-- search_card_names already had the corrected shape and served as the
-- template — it measured 720 ms cold / 84 ms warm where this measured
-- 7,299 / 634.
--
-- Two deliberate behaviour notes:
--
-- 1. face_names_text() joins the faces with a space and the branch matches the
--    concatenation rather than each face individually. Any pattern matching a
--    single face still matches the concatenation, so there are no false
--    negatives; the only new matches are patterns spanning a face boundary.
--    This is the same trade search_card_names already makes.
--
-- 2. The rewrite is LANGUAGE plpgsql rather than sql so the escaped patterns
--    live in variables. The old version computed them in a CTE and joined it,
--    which leaves the operands opaque at plan time; as plpgsql variables they
--    are passed as plan parameters and the index conditions bind properly.
--
-- Verified equivalent before deploying, across
-- bolt / sol ring / dragon / jace / fire / delver / wrath / ab /
-- lightning bolt / 50%:
--   * identical result sets (0 rows exclusive to either side, both directions)
--   * identical top-10 ordering for every term
-- Timings: bolt 714 ms -> 9 ms, fire 583 -> 35, dragon 595 -> 70.
--
-- Not improved: 2-character terms ("ab", 578 -> 592 ms). A 2-char string has
-- no complete trigram, so GIN cannot be selective and the scan is inherent.
-- The client floor is 2 chars (searchCards returns early below it), so this
-- remains the worst case. Raising that floor to 3 would remove it, but that
-- is a UX decision, not a migration.

create or replace function public.search_deck_builder_cards(
  search_term text,
  page_size   integer default 41,
  page_offset integer default 0
)
returns setof oracle_cards
language plpgsql
stable
set search_path to 'public', 'extensions'
as $function$
declare
  v_raw     text := trim(coalesce(search_term, ''));
  v_pattern text;
  v_prefix  text;
  v_limit   int  := greatest(1, least(coalesce(page_size, 41), 51));
  v_offset  int  := greatest(0, coalesce(page_offset, 0));
begin
  -- Matches the old `where length(i.raw) >= 2`, which returned an empty set.
  if length(v_raw) < 2 then
    return;
  end if;

  v_pattern := '%' || replace(replace(replace(v_raw, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_prefix  :=        replace(replace(replace(v_raw, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  with cand as (
    select oc.oracle_id from public.oracle_cards oc where oc.name ilike v_pattern
    union
    select oc.oracle_id from public.oracle_cards oc where oc.name % v_raw
    union
    select oc.oracle_id from public.oracle_cards oc
     -- array_length(...) > 0 repeats oracle_cards_face_trgm_idx's WHERE
     -- clause; without it the partial index cannot be used.
     where array_length(oc.face_names, 1) > 0
       and public.face_names_text(oc.face_names) ilike v_pattern
  )
  select oc.*
    from public.oracle_cards oc
    join cand c on c.oracle_id = oc.oracle_id
   where coalesce(oc.type_line, '') not ilike 'token%'
     and coalesce(oc.type_line, '') not ilike 'emblem%'
     and coalesce(oc.type_line, '') not ilike 'card%'
     and coalesce(oc.type_line, '') not ilike 'vanguard%'
     and coalesce(oc.type_line, '') not ilike 'scheme%'
     and coalesce(oc.type_line, '') not ilike 'ongoing scheme%'
     and coalesce(oc.type_line, '') not ilike 'plane %'
     and coalesce(oc.type_line, '') not ilike 'phenomenon%'
     and coalesce(oc.type_line, '') not ilike 'sticker%'
   order by (lower(oc.name) = lower(v_raw)) desc,
            (oc.name ilike v_prefix)        desc,
            similarity(oc.name, v_raw)      desc,
            oc.name                         asc
   limit v_limit
  offset v_offset;
end
$function$;

-- CREATE OR REPLACE preserves existing grants, but this is re-asserted so a
-- fresh database built from migrations alone ends up with the same ACL as
-- production (anon, authenticated, service_role).
grant execute on function public.search_deck_builder_cards(text, integer, integer)
  to anon, authenticated, service_role;
