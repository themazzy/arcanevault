-- Make public profiles load in one indexed row read.
--
-- 20260801190000 fixed the worst of it (stale visibility map + a too-narrow
-- covering index took get_public_profile from 15.5s to ~0.8s), but measuring the
-- result five times gave 232ms, 4,052ms and 5,545ms for the SAME call. The
-- variance is structural, not noise: card_prints is ~110MB and card_prices
-- ~100MB against a 224MB shared_buffers, so the two tables evict each other and
-- a miss costs ~2ms per 8KB page on this volume. Any profile view that walks
-- 12k owned rows is a coin flip between fast and unusable.
--
-- So stop walking them on page load. Everything that needs the card_prints /
-- card_prices join is precomputed into profile_stats and read back as a single
-- primary-key lookup. What stays live is only what is cheap and wants to be
-- exact.
--
-- Freshness:
--   * nightly pg_cron at 04:40 UTC, after the 03:20 price sync and the 04:30
--     value snapshots, so a refresh always sees the day's prices;
--   * refresh_my_profile_stats() lets a signed-in owner rebuild their own row on
--     demand — Profile.jsx fires it after first paint, so your own numbers
--     correct themselves within a second of opening your page.
--
-- Caching prices costs nothing in fidelity: card_prices only has one snapshot
-- per day anyway, so a nightly-computed collection value is exactly as current
-- as a live one.

-- NOTE ON card_prices_lookup_cover: an earlier draft of this migration created
-- a covering index on card_prices (scryfall_id, snapshot_date) INCLUDE (prices)
-- to make the price lookup index-only. It was built, measured, and DROPPED —
-- deliberately. Once the read path became a profile_stats lookup, the only
-- remaining consumers of that join were the 04:40 cron and the owner's
-- fire-and-forget refresh, i.e. nobody waits on it. Measured with the index:
-- 3,230ms. Without: 2,117ms (the pkey has the same leading columns; card_prices
-- is only ~35MB of heap so it stays cached). It cost 16MB on a 500MB database
-- to make an unattended job slower. Do not re-add it without a measurement that
-- says otherwise.

-- ── Cache table ───────────────────────────────────────────────────────────────
create table if not exists public.profile_stats (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  computed_at        timestamptz not null default now(),
  total_cards        bigint      not null default 0,
  unique_cards       bigint      not null default 0,
  foil_count         bigint      not null default 0,
  sets_count         bigint      not null default 0,
  color_distribution jsonb       not null default '{}'::jsonb,
  rarity_breakdown   jsonb       not null default '{}'::jsonb,
  collection_value   numeric,
  top_cards          jsonb,
  recent_cards       jsonb
);

alter table public.profile_stats enable row level security;

-- Public reads go through get_public_profile (SECURITY DEFINER), never directly,
-- so anon gets nothing here. Owners may read their own row to show freshness.
-- auth.uid() is wrapped in a scalar subquery so Postgres hoists it to an
-- InitPlan instead of re-evaluating it per row (Supabase auth_rls_initplan).
drop policy if exists profile_stats_owner_select on public.profile_stats;
create policy profile_stats_owner_select on public.profile_stats
  for select to authenticated
  using (user_id = (select auth.uid()));

-- New public-schema tables are not auto-exposed from 2026-10-30, so grant
-- explicitly. Writes only ever happen inside the SECURITY DEFINER refreshers.
grant select on public.profile_stats to authenticated;

-- ── Refresher ─────────────────────────────────────────────────────────────────
create or replace function public.refresh_profile_stats(p_user_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '120s'
as $function$
declare
  v_total      bigint;
  v_unique     bigint;
  v_foil       bigint;
  v_sets       bigint;
  v_colors     jsonb;
  v_rarity     jsonb;
  v_value      numeric;
  v_top_cards  jsonb;
  v_recent     jsonb;
begin
  select
    coalesce(sum(qty), 0)::bigint,
    count(distinct (card_print_id, foil))::bigint,
    coalesce(sum(qty) filter (where foil), 0)::bigint
  into v_total, v_unique, v_foil
  from cards
  where user_id = p_user_id;

  -- One index-only pass over cards -> card_prints. `owned` is referenced four
  -- times, so Postgres materialises it instead of re-scanning per aggregate.
  with owned as (
    select c.qty, cp.set_code, cp.rarity, cp.color_identity
    from cards c
    join card_prints cp on cp.id = c.card_print_id
    where c.user_id = p_user_id
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
  into v_sets, v_colors, v_rarity;

  -- Value + the five most valuable prints share one priced pass.
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
    where c.user_id = p_user_id
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
  into v_value, v_top_cards;

  select jsonb_agg(
           jsonb_build_object('name', cp.name, 'image_uri', cp.image_uri)
           order by sub.added_at desc
         )
  into v_recent
  from (
    select card_print_id, added_at
    from cards
    where user_id = p_user_id
    order by added_at desc
    limit 8
  ) sub
  join card_prints cp on cp.id = sub.card_print_id;

  insert into public.profile_stats as ps (
    user_id, computed_at, total_cards, unique_cards, foil_count, sets_count,
    color_distribution, rarity_breakdown, collection_value, top_cards, recent_cards
  )
  values (
    p_user_id, now(), v_total, v_unique, v_foil, coalesce(v_sets, 0),
    coalesce(v_colors, '{}'::jsonb), coalesce(v_rarity, '{}'::jsonb),
    v_value, v_top_cards, v_recent
  )
  on conflict (user_id) do update set
    computed_at        = excluded.computed_at,
    total_cards        = excluded.total_cards,
    unique_cards       = excluded.unique_cards,
    foil_count         = excluded.foil_count,
    sets_count         = excluded.sets_count,
    color_distribution = excluded.color_distribution,
    rarity_breakdown   = excluded.rarity_breakdown,
    collection_value   = excluded.collection_value,
    top_cards          = excluded.top_cards,
    recent_cards       = excluded.recent_cards;
end;
$function$;

-- REVOKE FROM PUBLIC, not from anon/authenticated. Postgres grants EXECUTE to
-- PUBLIC on every new function and those roles inherit it, so revoking from
-- them by name is a no-op — see 20260801220000_fix_profile_stats_function_grants.
revoke execute on function public.refresh_profile_stats(uuid) from public, anon, authenticated;

-- Owner-triggered refresh. Safe to expose: it can only ever rebuild the caller's
-- own row, and it is the escape hatch that keeps your own profile honest between
-- nightly runs.
create or replace function public.refresh_my_profile_stats()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  perform public.refresh_profile_stats(auth.uid());
end;
$function$;

revoke execute on function public.refresh_my_profile_stats() from public, anon;
grant execute on function public.refresh_my_profile_stats() to authenticated;

-- Nightly sweep over everyone who actually has a public profile.
create or replace function public.refresh_all_profile_stats()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '600s'
as $function$
declare r record;
begin
  for r in
    select user_id from user_settings
    where nickname is not null and btrim(nickname) <> ''
  loop
    begin
      perform public.refresh_profile_stats(r.user_id);
    exception when others then
      -- One bad row must not abort the sweep.
      raise warning 'refresh_profile_stats failed for %: %', r.user_id, sqlerrm;
    end;
  end loop;
end;
$function$;

revoke execute on function public.refresh_all_profile_stats() from public, anon, authenticated;

-- ── Read path ─────────────────────────────────────────────────────────────────
-- Single PK lookup into profile_stats. What stays live: deck count (small, and
-- visibly wrong if stale after publishing a deck) and the game record (a handful
-- of rows). Everything else comes from the cache.
create or replace function public.get_public_profile(p_username text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '20s'
as $function$
declare
  v_user_id     uuid;
  v_row         user_settings%rowtype;
  v_joined_at   timestamptz;
  v_st          profile_stats%rowtype;
  v_deck_count  bigint;
  v_game_stats  jsonb;
  v_blocks      jsonb;
  v_show_value  boolean;
  v_show_crown  boolean;
  v_show_top    boolean;
  v_show_recent boolean;
  v_show_games  boolean;
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

  -- The reads are all cheap now, so these gates are about disclosure rather than
  -- cost: a profile that hides its value / crown / games publishes neither.
  select
    bool_or(b->>'id' = 'value'        and (b->>'enabled')::boolean),
    bool_or(b->>'id' = 'crown'        and (b->>'enabled')::boolean),
    bool_or(b->>'id' = 'top_cards'    and (b->>'enabled')::boolean),
    bool_or(b->>'id' = 'recent_cards' and (b->>'enabled')::boolean),
    bool_or(b->>'id' in ('winrate','fav_format','milestones')
                                      and (b->>'enabled')::boolean)
  into v_show_value, v_show_crown, v_show_top, v_show_recent, v_show_games
  from jsonb_array_elements(v_blocks) b;

  select created_at into v_joined_at from auth.users where id = v_user_id;

  select * into v_st from profile_stats where user_id = v_user_id;

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

  return jsonb_build_object(
    'nickname',          v_row.nickname,
    'bio',               coalesce(v_row.profile_bio, ''),
    'accent',            coalesce(v_row.profile_accent, ''),
    'premium',           coalesce(v_row.premium, false),
    'bento_config',      coalesce(v_row.profile_config, '{"blocks":[]}'::jsonb),
    'joined_at',         v_joined_at,
    'stats_computed_at', v_st.computed_at,
    'stats',             jsonb_build_object(
                           'total_cards',        coalesce(v_st.total_cards, 0),
                           'unique_cards',       coalesce(v_st.unique_cards, 0),
                           'foil_count',         coalesce(v_st.foil_count, 0),
                           'sets_count',         coalesce(v_st.sets_count, 0),
                           'color_distribution', coalesce(v_st.color_distribution, '{}'::jsonb),
                           'rarity_breakdown',   coalesce(v_st.rarity_breakdown, '{}'::jsonb)
                         ),
    'collection_value',  case when coalesce(v_show_value, false) then v_st.collection_value end,
    'top_card',          case when coalesce(v_show_crown, false) then v_st.top_cards -> 0 end,
    'top_cards',         case when coalesce(v_show_top, false) then v_st.top_cards end,
    'recent_cards',      case when coalesce(v_show_recent, false) then v_st.recent_cards end,
    'game_stats',        v_game_stats,
    'public_deck_count', v_deck_count
  );
end;
$function$;

-- Seed every existing profile so nobody waits for the first nightly run.
select public.refresh_all_profile_stats();

select cron.schedule(
  'daily-profile-stats',
  '40 4 * * *',
  $$select public.refresh_all_profile_stats()$$
);

notify pgrst, 'reload schema';
