-- Card-name autocomplete was scanning all 38,351 oracle_cards rows per search.
-- pg_stat_statements: 2,139ms mean. Measured directly: 2,341-3,288ms.
--
-- ── The actual cause (I got this wrong twice first) ───────────────────────────
-- The WHERE was an OR of three predicates and the third,
--   exists (select 1 from unnest(oc.face_names) fn where fn ilike pattern)
-- cannot be indexed — you cannot index an unnest. One unindexable branch in an
-- OR forces a seq scan of the whole table.
--
-- Two things I believed on the way that were WRONG, recorded so nobody retests
-- them:
--   1. "Rewriting the OR as a UNION fixes it." It does not. Splitting the OR
--      lets branches 1 and 2 use the trigram index, but branch 3 still has to
--      scan every row looking for face matches. Measured 56ms standalone and I
--      generalised from it — that reading was a WARM CACHE. The same branch
--      costs 30ms warm and 2,843ms cold, because oracle_cards' 50MB heap is
--      fighting card_prints and card_prices for a 224MB buffer pool. The
--      function's latency was that one branch's cache luck.
--   2. "The `input` CTE defeats the index because `name ILIKE i.pattern` is a
--      join predicate." Also wrong — verified the CTE form uses the index (5ms),
--      and a PREPAREd $1 parameter uses it too (4ms).
--
-- ── The fix ──────────────────────────────────────────────────────────────────
-- Make branch 3 indexable. array_to_string is only STABLE so it cannot go in an
-- index expression; face_names_text() is an IMMUTABLE wrapper (concatenating
-- array elements with a separator is deterministic). The GIN trigram index is
-- PARTIAL — only the 3,200 rows (8.3%) that actually have face names — so it
-- costs 632kB.
--
-- The joined-string match is a strict SUPERSET of "any single face matches"
-- (a pattern could span the separator, e.g. faces ['Fire','Ice'] joined to
-- 'Fire Ice' matches '%e i%'), so the exact EXISTS is KEPT as a recheck after
-- the index narrows the candidates. Superset filtered back down = identical
-- results, at index speed.
--
-- Branch 3: 2,843ms -> 6ms. Whole function: 2,341-3,288ms -> 403-794ms.
-- Buffers touched: ~7,800 -> 1,388.
--
-- Honest note on the remaining time: at 1,388 buffers, ALL cache hits, 515ms is
-- ~0.37ms per cached buffer access. The work is now small; the instance is just
-- slow. The dominant branch left is `name % raw` (371ms) — the trigram index
-- returns 943 candidates and the similarity recheck discards 854 over 886 heap
-- blocks. Tightening that means raising pg_trgm.similarity_threshold, which
-- CHANGES which fuzzy matches are returned. Not done: it is a semantic change,
-- not a free optimisation.
--
-- ── Equivalence ──────────────────────────────────────────────────────────────
-- Verified against a reference implementation of the ORIGINAL body: 58 terms
-- (28 hand-picked + 30 randomised fragments of real card names) compared as md5
-- of the ORDERED oracle_id list. 58/58 identical. Covered: the <2-char gate,
-- '%' and '_' escaping, split cards ('fire // ice'), the cross-face-boundary
-- cases ('fire ice', 'ice'), DFC face matches ('valki', 'esika', 'kenrith'),
-- and no-match terms.

-- search_path is pinned and the call schema-qualified because this function is
-- baked into an index expression: it runs during index maintenance, and
-- resolving a different function there would silently corrupt the index rather
-- than raise an error.
create or replace function public.face_names_text(text[])
 returns text
 language sql
 immutable
 parallel safe
 set search_path to ''
as $$ select pg_catalog.array_to_string($1, ' ') $$;

create index if not exists oracle_cards_face_trgm_idx on public.oracle_cards
  using gin (public.face_names_text(face_names) extensions.gin_trgm_ops)
  where array_length(face_names, 1) > 0;

create or replace function public.search_card_names(search_term text, max_results integer default 20)
 returns setof oracle_cards
 language sql
 stable
 set search_path to 'public', 'extensions'
as $function$
  with input as (
    select
      trim(coalesce(search_term, '')) as raw,
      '%' || replace(replace(replace(trim(coalesce(search_term, '')),
        '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern,
      replace(replace(replace(trim(coalesce(search_term, '')),
        '\', '\\'), '%', '\%'), '_', '\_') || '%' as prefix_pattern
  ),
  -- One branch per access path so each can use an index. As a single OR the
  -- planner has to seq-scan for all three.
  candidates as (
    -- Substring match -> oracle_cards_name_trgm_idx
    select oc.oracle_id from public.oracle_cards oc, input i
    where length(i.raw) >= 2 and oc.name ilike i.pattern
    union
    -- Fuzzy/typo match -> same index
    select oc.oracle_id from public.oracle_cards oc, input i
    where length(i.raw) >= 2 and oc.name % i.raw
    union
    -- Back faces of double-faced cards -> oracle_cards_face_trgm_idx, then the
    -- exact per-face check as a recheck on the narrowed set.
    select oc.oracle_id from public.oracle_cards oc, input i
    where length(i.raw) >= 2
      and array_length(oc.face_names, 1) > 0
      and public.face_names_text(oc.face_names) ilike i.pattern
      and exists (select 1 from unnest(oc.face_names) fn where fn ilike i.pattern)
  )
  select oc.*
  from public.oracle_cards oc
  join candidates c on c.oracle_id = oc.oracle_id
  cross join input i
  where coalesce(oc.type_line, '') not ilike 'token%'
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
$function$;

notify pgrst, 'reload schema';
