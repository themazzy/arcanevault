-- Activation and retention figures for the /admin Traffic tab.
--
-- The tab could measure visits but not people: whether someone came back lives
-- in Postgres, not in Cloudflare's analytics.
--
-- Two fields that look like the obvious signal are deliberately NOT used:
--
--   * auth.users.last_sign_in_at only updates on an explicit sign-in. Supabase
--     sessions auto-refresh, so a daily user can go months without bumping it.
--     Reading it as "last seen" reports almost everyone as never returning.
--   * user_settings.updated_at is written by backfills. The 2026-08-08
--     assign_default_user_settings_on_signup migration touched one row for each
--     of 15 users on a single day, which reads as 15 people active that day.
--
-- "Active" here means a day on which the user actually created or edited
-- something they own. Aggregation happens here rather than in the edge function
-- so the row scan never leaves the database.

create or replace function public.admin_user_activity_summary(p_days int default 30)
returns jsonb
language sql
security definer
set search_path = public
set statement_timeout to '20s'
as $$
  with bounds as (
    select greatest(coalesce(p_days, 30), 1) as days
  ),
  activity as (
    select user_id, date(updated_at) as d from public.cards where user_id is not null
    union all
    select user_id, date(coalesce(updated_at, created_at)) from public.folders where user_id is not null
    union all
    select user_id, date(coalesce(updated_at, created_at)) from public.deck_cards where user_id is not null
    union all
    select user_id, date(coalesce(updated_at, created_at)) from public.deck_allocations where user_id is not null
  ),
  per_user as (
    select user_id, count(distinct d) as active_days, max(d) as last_active
    from activity
    group by user_id
  ),
  people as (
    select
      u.id,
      date(u.created_at) as signed_up,
      coalesce(p.active_days, 0) as active_days,
      p.last_active
    from auth.users u
    left join per_user p on p.user_id = u.id
  )
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'accounts', count(*),
        'signups_range', count(*) filter (where signed_up >= current_date - (select days from bounds)),
        'signups_7d', count(*) filter (where signed_up >= current_date - 7),
        -- Anyone who ever created a card, folder or deck card.
        'activated', count(*) filter (where active_days >= 1),
        -- Came back on a second distinct day. The headline retention number.
        'returning', count(*) filter (where active_days >= 2),
        'active_7d', count(*) filter (where last_active >= current_date - 7),
        'active_30d', count(*) filter (where last_active >= current_date - 30)
      )
      from people
    ),
    'buckets', (
      select jsonb_agg(b order by b.sort)
      from (
        select 'Never used it' as label, count(*) as count, 1 as sort from people where active_days = 0
        union all
        select 'One session', count(*), 2 from people where active_days = 1
        union all
        select '2-3 days', count(*), 3 from people where active_days between 2 and 3
        union all
        select '4+ days', count(*), 4 from people where active_days >= 4
      ) b
    ),
    'signups_daily', (
      select coalesce(jsonb_agg(jsonb_build_object('date', to_char(signed_up, 'YYYY-MM-DD'), 'signups', n) order by signed_up), '[]'::jsonb)
      from (
        select signed_up, count(*) as n
        from people
        where signed_up >= current_date - (select days from bounds)
        group by signed_up
      ) s
    ),
    'cohorts', (
      -- Weekly cohorts, newest first. Small numbers, so the point is the shape:
      -- how many of each week's signups ever started, and how many came back.
      select coalesce(jsonb_agg(jsonb_build_object(
        'week', to_char(wk, 'YYYY-MM-DD'),
        'signups', signups,
        'activated', activated,
        'returning', returned
      ) order by wk desc), '[]'::jsonb)
      from (
        select
          date_trunc('week', signed_up)::date as wk,
          count(*) as signups,
          count(*) filter (where active_days >= 1) as activated,
          -- Aliased `returned`: `returning` is a reserved word in Postgres.
          count(*) filter (where active_days >= 2) as returned
        from people
        where signed_up >= current_date - 56
        group by 1
      ) c
    )
  );
$$;

-- Admin-only: reached through the admin-gated edge function with the service
-- role. Revoking from PUBLIC rather than from anon/authenticated, since a
-- revoke from those roles alone leaves the function world-callable.
revoke execute on function public.admin_user_activity_summary(int) from public;
