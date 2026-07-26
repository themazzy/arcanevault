-- Make the deck rollup trigger index-friendly.
--
-- refresh_deck_rollups resolved a linked deck by comparing `dc.deck_id::text`
-- to the id stored in the folder's description JSON. Casting the indexed uuid
-- column to text made deck_cards_deck_id_idx unusable, so every rollup ran a
-- sequential scan of the *whole* deck_cards table — every user's rows — to find
-- one deck's cards.
--
-- That trigger fires once per deck_cards statement, and DeckBuilder's
-- "set commander" path upserts the entire deck in one go. Measured on a 100-card
-- deck: the upsert took 549 ms, 346 ms of it inside this trigger, of which
-- 143 ms was the seq scan (8,820 rows discarded to keep 100). The cost grows
-- with the global table, so under the I/O contention that follows the nightly
-- price sync it reached the 8 s statement timeout and the write failed with
-- 57014.
--
-- The fix is to compare uuid to uuid: cast the JSON text to uuid instead of the
-- column to text. safe_uuid() keeps a malformed id in a description blob from
-- raising — it degrades to "no link", exactly like the old nullif did.
create or replace function public.safe_uuid(p_text text)
returns uuid
language plpgsql
immutable
strict
set search_path to ''
as $$
begin
  return p_text::uuid;
exception when others then
  return null;
end;
$$;

comment on function public.safe_uuid(text) is
  'Parse text as uuid, returning null instead of raising. For ids read out of description JSON blobs.';

create or replace function public.refresh_deck_rollups(p_deck_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ids uuid[];
begin
  -- A linked pair's collection side derives its count from the builder side's
  -- deck_cards, so a deck_cards change on the builder folder must also
  -- refresh its paired collection folder's cached rollup.
  select array_agg(distinct id) into v_ids
  from (
    select unnest(p_deck_ids) as id
    union
    select f2.id
    from public.folders b
    join public.folders f2
      on f2.id = public.safe_uuid(nullif(public.safe_jsonb(b.description)->>'linked_deck_id', ''))
    where b.id = any(p_deck_ids)
      and b.type = 'builder_deck'
  ) x
  where id is not null;

  update public.folders f set
    deck_color_identity = coalesce((
      select array_agg(distinct ci order by ci)
      from (
        select unnest(cp.color_identity) as ci
        from public.deck_cards dc
        join public.card_prints cp on cp.id = dc.card_print_id
        where dc.deck_id = f.id
        union
        select unnest(cp.color_identity) as ci
        from public.deck_allocations da
        join public.cards c on c.id = da.card_id
        join public.card_prints cp on cp.id = c.card_print_id
        where da.deck_id = f.id
      ) colors
      where ci in ('W','U','B','R','G','C')
    ), '{}'::text[]),
    deck_card_count = case
      when f.type = 'builder_deck' then
        coalesce((select sum(dc.qty)::int from public.deck_cards dc where dc.deck_id = f.id), 0)
      else
        coalesce(
          (
            select sum(dc.qty)::int
            from public.deck_cards dc
            where dc.deck_id = coalesce(
              public.safe_uuid(nullif(public.safe_jsonb(f.description)->>'linked_builder_id', '')),
              f.id
            )
          ),
          (select sum(da.qty)::int from public.deck_allocations da where da.deck_id = f.id),
          0
        )
    end
  where f.id = any(v_ids);
end;
$function$;
