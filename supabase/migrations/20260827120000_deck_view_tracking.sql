-- Deck view tracking — first-party counts for public deck shortlinks (/d/<id>).
--
-- Aggregate only: one row per deck (running total) plus one row per deck per day
-- (for trend/"top decks this week" queries). Raw per-view event rows are
-- deliberately NOT stored — the database is already dominated by the Scryfall
-- catalogue and a pageview log would be unbounded growth for no extra answer.

create table if not exists public.deck_view_stats (
  deck_id        uuid primary key references public.folders(id) on delete cascade,
  total_views    bigint not null default 0,
  last_viewed_at timestamptz
);

create table if not exists public.deck_view_daily (
  deck_id   uuid not null references public.folders(id) on delete cascade,
  view_date date not null,
  views     integer not null default 0,
  primary key (deck_id, view_date)
);

create index if not exists deck_view_daily_date_idx
  on public.deck_view_daily (view_date desc);

alter table public.deck_view_stats enable row level security;
alter table public.deck_view_daily enable row level security;

-- Owners may read their own deck's counts. Everything else (admin traffic
-- summary) goes through the service role, which bypasses RLS.
drop policy if exists deck_view_stats_owner_read on public.deck_view_stats;
create policy deck_view_stats_owner_read on public.deck_view_stats
  for select to authenticated
  using (exists (
    select 1 from public.folders f
    where f.id = deck_view_stats.deck_id and f.user_id = auth.uid()
  ));

drop policy if exists deck_view_daily_owner_read on public.deck_view_daily;
create policy deck_view_daily_owner_read on public.deck_view_daily
  for select to authenticated
  using (exists (
    select 1 from public.folders f
    where f.id = deck_view_daily.deck_id and f.user_id = auth.uid()
  ));

grant select on public.deck_view_stats to authenticated;
grant select on public.deck_view_daily to authenticated;

-- Increment a public deck's view counters.
--
-- Gated on the same is_public meta flag as get_deck_og_meta, so a private deck
-- never accrues counts (and a probe of random UUIDs learns nothing — the
-- function returns silently either way).
create or replace function public.record_deck_view(p_deck_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_meta jsonb;
begin
  select f.user_id, public.safe_jsonb(f.description)
    into v_user_id, v_meta
  from public.folders f
  where f.id = p_deck_id;

  if v_user_id is null or coalesce(v_meta->>'is_public', 'false') <> 'true' then
    return;
  end if;

  insert into public.deck_view_stats as s (deck_id, total_views, last_viewed_at)
  values (p_deck_id, 1, now())
  on conflict (deck_id) do update
    set total_views = s.total_views + 1,
        last_viewed_at = now();

  insert into public.deck_view_daily as d (deck_id, view_date, views)
  values (p_deck_id, current_date, 1)
  on conflict (deck_id, view_date) do update
    set views = d.views + 1;
end;
$$;

revoke execute on function public.record_deck_view(uuid) from public;
grant execute on function public.record_deck_view(uuid) to anon, authenticated;

-- Daily rows are small, but unbounded in time. Prune beyond 180 days; running
-- totals in deck_view_stats are unaffected. Schedule via pg_cron alongside the
-- other maintenance jobs.
create or replace function public.prune_deck_view_daily()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.deck_view_daily where view_date < current_date - 180;
$$;

revoke execute on function public.prune_deck_view_daily() from public;
