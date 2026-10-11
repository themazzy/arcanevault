-- Bound what the public API can write, so nobody can fill the database.
--
-- The free plan turns the database read-only past 500 MB, and on 2026-10-11 it
-- sat at 341 MB. Before this migration a short script holding only the public
-- anon key could close that gap:
--
--   * signed-out visitors could insert unlimited `feedback` and
--     `account_deletion_requests` rows of unlimited length;
--   * any signed-in account could insert unlimited rows into the shared
--     `card_prints` catalogue (policy WITH CHECK (true), no validation), and
--     those rows surface in every user's search, printings list and art picker,
--     with whatever image URL the inserter chose;
--   * `trade_proposals` (via propose_trade), `folders.description` and
--     `user_settings` took arbitrarily large text/jsonb;
--   * the `assets` storage bucket had no file-size limit and no type filter.
--
-- Applied as three migrations: this one (quotas), _sizes (CHECKs + storage)
-- and _prune (counter cleanup job).
--
-- Two kinds of bound, deliberately independent:
--
-- 1. Size CHECKs. Every limit is >= 10x the largest value in production when
--    this was written (measured, noted per column), so no current row and no
--    plausible legitimate write is affected.
--
-- 2. Daily row quotas, enforced by one statement-level trigger, counted in
--    private.write_quota. Only requests that arrive through the API as anon or
--    authenticated are counted. The service_role sync scripts, pg_cron jobs and
--    SECURITY DEFINER bodies called by those roles are not, because the role is
--    read from the request's JWT claims rather than current_user (which a
--    SECURITY DEFINER function such as propose_trade would replace with its
--    owner). Signed-out callers share one global allowance: there is no
--    identity to key them on, and a cap that can be exhausted is still better
--    than no cap.
--
-- card_prints keeps its client insert path (ensureCardPrints pushes back
-- prints fetched from Scryfall). The CHECKs below restrict image URLs to
-- Scryfall's CDN at the row's own scryfall_id, so an inserted row can no longer
-- carry an arbitrary image.

-- ── Quota store ─────────────────────────────────────────────────────────────

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.write_quota (
  bucket text not null,
  actor  text not null,           -- auth.uid() as text, or 'anon'
  day    date not null default current_date,
  n      integer not null default 0,
  primary key (bucket, actor, day)
);
revoke all on private.write_quota from public, anon, authenticated;

-- TG_ARGV: [0] bucket name, [1] per-user daily limit, [2] shared anon daily limit
create or replace function private.enforce_daily_insert_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  v_rows  integer;
  v_actor text;
  v_limit integer;
  v_n     integer;
begin
  if v_role is null or v_role not in ('anon', 'authenticated') then
    return null;
  end if;

  select count(*) into v_rows from new_rows;
  if v_rows = 0 then return null; end if;

  v_actor := coalesce(auth.uid()::text, 'anon');
  v_limit := case when v_actor = 'anon' then tg_argv[2]::integer else tg_argv[1]::integer end;

  insert into private.write_quota as q (bucket, actor, day, n)
  values (tg_argv[0], v_actor, current_date, v_rows)
  on conflict (bucket, actor, day) do update set n = q.n + excluded.n
  returning q.n into v_n;

  if v_n > v_limit then
    -- Raising rolls back the insert and the counter increment together.
    raise exception 'Daily limit reached for %. Please try again tomorrow.', tg_argv[0]
      using errcode = '54000';
  end if;
  return null;
end;
$$;
revoke all on function private.enforce_daily_insert_quota() from public, anon, authenticated;

-- Largest observed per-day insert counts on 2026-10-11, for scale: card_prints
-- 317 rows/day across ALL writers including the daily sync; feedback and
-- trade_proposals were empty; account_deletion_requests held a handful of rows.

create trigger card_prints_insert_quota
  after insert on public.card_prints
  referencing new table as new_rows
  for each statement execute function private.enforce_daily_insert_quota('card_prints', '2000', '0');

create trigger feedback_insert_quota
  after insert on public.feedback
  referencing new table as new_rows
  for each statement execute function private.enforce_daily_insert_quota('feedback', '20', '50');

create trigger feedback_attachments_insert_quota
  after insert on public.feedback_attachments
  referencing new table as new_rows
  for each statement execute function private.enforce_daily_insert_quota('feedback_attachments', '20', '0');

create trigger account_deletion_requests_insert_quota
  after insert on public.account_deletion_requests
  referencing new table as new_rows
  for each statement execute function private.enforce_daily_insert_quota('account_deletion_requests', '5', '20');

create trigger trade_proposals_insert_quota
  after insert on public.trade_proposals
  referencing new table as new_rows
  for each statement execute function private.enforce_daily_insert_quota('trade_proposals', '50', '0');
