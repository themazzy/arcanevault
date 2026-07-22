-- Builder's My Decks tiles and the Deck Browser (get_my_decks / get_community_decks)
-- both read folders.deck_card_count. For type='deck' rows it was always summed
-- from deck_allocations (owned/synced cards) — but DeckBuilder can edit a
-- collection deck's own deck_cards directly (standalone decks opened in
-- DeckBuilder, and linked pairs where the builder side holds the intended
-- list). Result: a deck tile in Builder showed the last-synced allocation
-- count, not the deckbuilder's actual card count, whenever the user added
-- cards in DeckBuilder without syncing back to the collection.
--
-- deck_cards is the intended-list source of truth in Builder (see CLAUDE.md
-- "Deck Model"), so the rollup should prefer it whenever it has rows:
--   - builder_deck            → deck_cards for this folder (unchanged)
--   - deck, linked to builder → deck_cards for the linked builder folder
--   - deck, standalone        → this folder's own deck_cards if it has any
--                                (i.e. it's been opened/edited in DeckBuilder),
--                                else fall back to deck_allocations (a deck
--                                never touched in Builder has no deck_cards yet)

create or replace function public.refresh_deck_rollups(p_deck_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
      on f2.id::text = nullif(public.safe_jsonb(b.description)->>'linked_deck_id', '')
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
            where dc.deck_id::text = coalesce(
              nullif(public.safe_jsonb(f.description)->>'linked_builder_id', ''),
              f.id::text
            )
          ),
          (select sum(da.qty)::int from public.deck_allocations da where da.deck_id = f.id),
          0
        )
    end
  where f.id = any(v_ids);
end;
$$;

revoke all on function public.refresh_deck_rollups(uuid[]) from public, anon, authenticated;

-- Backfill: recompute every deck/builder_deck rollup under the corrected rule.
select public.refresh_deck_rollups(array(
  select id from public.folders where type in ('builder_deck', 'deck')
));

notify pgrst, 'reload schema';
