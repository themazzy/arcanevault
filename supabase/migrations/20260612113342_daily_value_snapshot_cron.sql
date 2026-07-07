-- Daily collection-value snapshots, server-side. Until now snapshots were
-- only written when a user opened the Stats page; this pg_cron job fills the
-- chart for every user every day, right after the 03:20 UTC price sync.
--
-- Division of labor:
--   - cron (04:30 UTC): computes totals from shared card_prices and inserts
--     with ON CONFLICT DO NOTHING — it never overwrites a row.
--   - client (Stats visit): upserts the same row WITH manual price overrides
--     applied, overwriting the cron value for that day. Richer data wins.

create or replace function public.record_daily_value_snapshots()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  with latest_prices as (
    -- Today's price row when the sync has run, else yesterday's.
    select distinct on (scryfall_id)
      scryfall_id, price_regular_eur, price_foil_eur, price_regular_usd, price_foil_usd
    from public.card_prices
    where snapshot_date >= current_date - 1
    order by scryfall_id, snapshot_date desc
  ),
  totals as (
    select
      c.user_id,
      sum(c.qty)::int as card_count,
      -- Mirror the client's getPrice fallback: preferred finish first, then
      -- the other finish, then 0.
      round(sum(c.qty * coalesce(
        case when c.foil then lp.price_foil_eur else lp.price_regular_eur end,
        case when c.foil then lp.price_regular_eur else lp.price_foil_eur end,
        0))::numeric, 2) as total_eur,
      round(sum(c.qty * coalesce(
        case when c.foil then lp.price_foil_usd else lp.price_regular_usd end,
        case when c.foil then lp.price_regular_usd else lp.price_foil_usd end,
        0))::numeric, 2) as total_usd
    from public.cards c
    left join public.card_prints cp on cp.id = c.card_print_id
    left join latest_prices lp on lp.scryfall_id = cp.scryfall_id
    group by c.user_id
  )
  insert into public.collection_value_snapshots (user_id, snapshot_date, total_eur, total_usd, card_count)
  select user_id, current_date, coalesce(total_eur, 0), coalesce(total_usd, 0), card_count
  from totals
  on conflict (user_id, snapshot_date) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- Reads every user's cards — must never be callable through the API.
revoke execute on function public.record_daily_value_snapshots() from public, anon, authenticated;

-- Schedule daily at 04:30 UTC (price sync runs 03:20 UTC). Idempotent.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'daily-collection-value-snapshots') then
    perform cron.unschedule('daily-collection-value-snapshots');
  end if;
end
$do$;

select cron.schedule(
  'daily-collection-value-snapshots',
  '30 4 * * *',
  'select public.record_daily_value_snapshots()'
);
