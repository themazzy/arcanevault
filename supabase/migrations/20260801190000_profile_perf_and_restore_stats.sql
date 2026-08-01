-- Public profiles were taking ~15.5s to load and restore the six stat blocks
-- that have rendered empty since 20260618125436_optimize_get_public_profile.
--
-- ── Why it was slow ────────────────────────────────────────────────────────────
-- Measured on the largest profile (12,168 `cards` rows), get_public_profile ran
-- 15,543ms — surviving only because the function sets statement_timeout to 20s.
-- Three compounding causes, none of them the SQL's shape:
--
--   1. STALE VISIBILITY MAP on card_prints. Last VACUUM was 2026-06-18 and the
--      daily price-sync backfill churns the table, so the "index only" scan on
--      card_prints_id_scry_cover did 5,840 heap fetches into a 110MB table.
--      shared_buffers here is 224MB and card_prints alone is half of it, so
--      those fetches missed cache and hit a throttled volume (~2ms per 8KB page
--      — a bare `count(*)` on card_prints took 7.7s).
--   2. NARROW COVERING INDEX. card_prints_id_scry_cover carries only
--      scryfall_id, so every set_code / rarity / color_identity read fell back
--      to the heap. That is the single hottest path in this function.
--   3. STALE ROW ESTIMATE on cards — the planner expected 2,440 rows and got
--      12,168 (5x low), which shaped the join badly.
--
-- ── What this migration does ───────────────────────────────────────────────────
--   * Widens the covering index so the whole aggregate pass is index-only
--     (Heap Fetches: 0). Measured: the card_prints leg fell 8,858ms -> 1,960ms,
--     and the full RPC 15,543ms -> 812ms cold / 170ms warm. A 1.5k-card profile
--     is 23ms.
--   * Tightens autovacuum on card_prints/card_prices/cards so the visibility map
--     and row estimates stay fresh. Without this the index-only scan silently
--     degrades back to heap fetches a few weeks after the next bulk sync, which
--     is exactly how the 15s regression appeared in the first place.
--   * Restores foil_count, sets_count, color_distribution, recent_cards and
--     top_cards, and adds rarity_breakdown (which the client has always read but
--     no migration ever produced). All of them are block-gated, so a profile only
--     pays for the blocks it actually shows.
--   * Adds game_stats so Win Rate / Most Played work for VISITORS. They were
--     fetched client-side under an `isOwn` guard, so anyone viewing someone
--     else's profile was told "No games tracked yet" regardless of the truth.
--
-- The returned JSON is a superset of the current shape — no client field moves.

-- ── 1. Covering index ─────────────────────────────────────────────────────────
-- Deliberately narrow: id + the four columns the aggregate pass reads. Adding
-- name/image_uri/art_crop_uri here would roughly triple it and undo the point,
-- which is that the index stays resident in a 224MB buffer pool. The display
-- fields are read for at most 5 rows via PK lookup.
--
-- NOTE: created with CREATE INDEX CONCURRENTLY against production before this
-- file was written, so this is a no-op there. `if not exists` keeps a fresh
-- environment correct.
create index if not exists card_prints_profile_cover
  on card_prints (id) include (scryfall_id, set_code, rarity, color_identity);

-- Strict subset of the index above; keeping both wastes ~8MB on a database
-- already at 346/500MB.
drop index if exists card_prints_id_scry_cover;

-- ── 2. Keep the plan from rotting ─────────────────────────────────────────────
-- Defaults (0.2 / 0.1) mean card_prints tolerates ~24k dead tuples before an
-- autovacuum, which is weeks of price-sync churn with a stale visibility map the
-- whole time.
alter table card_prints  set (autovacuum_vacuum_scale_factor  = 0.02,
                              autovacuum_analyze_scale_factor = 0.01);
alter table card_prices  set (autovacuum_vacuum_scale_factor  = 0.05,
                              autovacuum_analyze_scale_factor = 0.02);
alter table cards        set (autovacuum_analyze_scale_factor = 0.02);

-- ── 3. The function ───────────────────────────────────────────────────────────
create or replace function public.get_public_profile(p_username text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '20s'
as $function$
declare
  v_user_id       uuid;
  v_row           user_settings%rowtype;
  v_joined_at     timestamptz;
  v_total         bigint;
  v_unique        bigint;
  v_foil_count    bigint;
  v_sets_count    bigint;
  v_color_dist    jsonb;
  v_rarity        jsonb;
  v_value         numeric;
  v_value_raw     numeric;
  v_top_cards     jsonb;
  v_top_card      jsonb;
  v_recent_cards  jsonb;
  v_game_stats    jsonb;
  v_deck_count    bigint;
  v_blocks        jsonb;
  v_show_value    boolean;
  v_show_crown    boolean;
  v_show_top      boolean;
  v_show_break    boolean;
  v_show_recent   boolean;
  v_show_games    boolean;
begin
  select * into v_row
  from user_settings
  where lower(nickname) = lower(p_username)
  limit 1;

  if not found then
    return null;
  end if;

  v_user_id := v_row.user_id;
  v_blocks  := coalesce(v_row.profile_config->'blocks', '[]'::jsonb);

  -- Block gates. Every expensive pass below is behind one of these, so a profile
  -- showing only the default blocks never touches card_prices at all.
  -- 'milestones' joins the breakdown gate because milestone checks read
  -- sets_count and color_distribution; without it half the badges can never
  -- light up.
  select
    bool_or(b->>'id' = 'value'        and (b->>'enabled')::boolean),
    bool_or(b->>'id' = 'crown'        and (b->>'enabled')::boolean),
    bool_or(b->>'id' = 'top_cards'    and (b->>'enabled')::boolean),
    bool_or(b->>'id' in ('sets','color_pie','rarity','milestones')
                                      and (b->>'enabled')::boolean),
    bool_or(b->>'id' = 'recent_cards' and (b->>'enabled')::boolean),
    bool_or(b->>'id' in ('winrate','fav_format','milestones')
                                      and (b->>'enabled')::boolean)
  into v_show_value, v_show_crown, v_show_top, v_show_break, v_show_recent, v_show_games
  from jsonb_array_elements(v_blocks) b;

  select created_at into v_joined_at from auth.users where id = v_user_id;

  -- Always-on totals. `cards` only, no join — ~110ms even at 12k rows.
  select
    coalesce(sum(qty), 0)::bigint,
    count(distinct (card_print_id, foil))::bigint,
    coalesce(sum(qty) filter (where foil), 0)::bigint
  into v_total, v_unique, v_foil_count
  from cards
  where user_id = v_user_id;

  -- Sets / colours / rarity: one index-only pass over cards -> card_prints.
  -- `owned` is referenced four times so Postgres materialises it, giving a
  -- single scan feeding all three aggregates.
  if coalesce(v_show_break, false) then
    with owned as (
      select c.qty, cp.set_code, cp.rarity, cp.color_identity
      from cards c
      join card_prints cp on cp.id = c.card_print_id
      where c.user_id = v_user_id
    ),
    colors as (
      select t.col, sum(o.qty) as tot
      from owned o
      cross join lateral unnest(
        case when coalesce(array_length(o.color_identity, 1), 0) > 0
             then o.color_identity
             else array['C']::text[]
        end
      ) as t(col)
      group by t.col
    ),
    multi as (
      select coalesce(sum(qty), 0) as tot
      from owned
      where coalesce(array_length(color_identity, 1), 0) >= 2
    ),
    rar as (
      select rarity, sum(qty) as tot
      from owned
      where rarity is not null
      group by rarity
    )
    select
      (select count(distinct set_code) from owned),
      coalesce((select jsonb_object_agg(col, tot) from colors), '{}'::jsonb)
        || jsonb_build_object('M', coalesce((select tot from multi), 0)),
      coalesce((select jsonb_object_agg(rarity, tot) from rar), '{}'::jsonb)
    into v_sets_count, v_color_dist, v_rarity;
  end if;

  -- Value + top cards share one priced pass; crown is just the first entry.
  if coalesce(v_show_value, false)
     or coalesce(v_show_crown, false)
     or coalesce(v_show_top, false) then
    with priced as (
      select
        c.card_print_id,
        c.foil,
        c.qty,
        case
          when c.foil then coalesce(pr.price_foil_eur, pr.price_regular_eur, 0)
          else             coalesce(pr.price_regular_eur, pr.price_foil_eur, 0)
        end as price
      from cards c
      join card_prints cp on cp.id = c.card_print_id
      left join card_prices pr
        on pr.scryfall_id   = cp.scryfall_id
       and pr.snapshot_date = current_date
      where c.user_id = v_user_id
    ),
    top5 as (
      select * from priced where price > 0 order by price desc limit 5
    )
    select
      (select coalesce(sum(qty * price), 0)::numeric from priced),
      (select jsonb_agg(
                jsonb_build_object(
                  'name',             cp.name,
                  'set_code',         cp.set_code,
                  'collector_number', cp.collector_number,
                  'image_uri',        cp.image_uri,
                  'art_crop',         coalesce(
                                        cp.art_crop_uri,
                                        'https://cards.scryfall.io/art_crop/front/'
                                          || left(cp.scryfall_id, 1) || '/'
                                          || substr(cp.scryfall_id, 2, 1) || '/'
                                          || cp.scryfall_id || '.jpg'
                                      ),
                  'foil',             t.foil,
                  'price',            t.price
                ) order by t.price desc
              )
       from top5 t
       join card_prints cp on cp.id = t.card_print_id)
    into v_value_raw, v_top_cards;

    if coalesce(v_show_value, false) then
      v_value := v_value_raw;
    end if;
    if coalesce(v_show_crown, false) then
      v_top_card := v_top_cards -> 0;
    end if;
    if not coalesce(v_show_top, false) then
      v_top_cards := null;
    end if;
  end if;

  -- Recently added: 8 rows off the added_at index, then 8 PK lookups.
  if coalesce(v_show_recent, false) then
    select jsonb_agg(
             jsonb_build_object('name', cp.name, 'image_uri', cp.image_uri)
             order by sub.added_at desc
           )
    into v_recent_cards
    from (
      select card_print_id, added_at
      from cards
      where user_id = v_user_id
      order by added_at desc
      limit 8
    ) sub
    join card_prints cp on cp.id = sub.card_print_id;
  end if;

  -- Game record. Gated so a profile that hides both game blocks publishes
  -- nothing about its owner's match history.
  if coalesce(v_show_games, false) then
    select jsonb_build_object(
             'wins',       count(*) filter (where placement = 1),
             'losses',     count(*) filter (where placement is distinct from 1),
             'total',      count(*),
             'fav_format', (
               select format from game_results
               where user_id = v_user_id and format is not null
               group by format order by count(*) desc limit 1
             )
           )
    into v_game_stats
    from game_results
    where user_id = v_user_id;
  end if;

  select count(*) into v_deck_count
  from folders f
  cross join lateral public.safe_jsonb(f.description) meta
  where f.user_id = v_user_id
    and f.type in ('deck', 'builder_deck')
    and meta->>'is_public' = 'true'
    and not (
      f.type = 'deck'
      and meta->>'linked_builder_id' is not null
      and meta->>'linked_builder_id' != ''
    );

  return jsonb_build_object(
    'nickname',          v_row.nickname,
    'bio',               coalesce(v_row.profile_bio, ''),
    'accent',            coalesce(v_row.profile_accent, ''),
    'premium',           coalesce(v_row.premium, false),
    'bento_config',      coalesce(v_row.profile_config, '{"blocks":[]}'::jsonb),
    'joined_at',         v_joined_at,
    'stats',             jsonb_build_object(
                           'total_cards',        v_total,
                           'unique_cards',       v_unique,
                           'foil_count',         v_foil_count,
                           'sets_count',         v_sets_count,
                           'color_distribution', v_color_dist,
                           'rarity_breakdown',   v_rarity
                         ),
    'collection_value',  v_value,
    'top_card',          v_top_card,
    'top_cards',         v_top_cards,
    'recent_cards',      v_recent_cards,
    'game_stats',        v_game_stats,
    'public_deck_count', v_deck_count
  );
end;
$function$;
