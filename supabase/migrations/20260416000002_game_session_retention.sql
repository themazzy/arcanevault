create extension if not exists pg_cron;

alter table public.game_sessions
  add column if not exists created_at timestamptz not null default now();

alter table public.game_sessions
  add column if not exists started_at timestamptz;

alter table public.game_sessions
  add column if not exists ended_at timestamptz;

create index if not exists game_sessions_retention_idx
  on public.game_sessions (coalesce(ended_at, started_at, created_at));

create or replace function public.cleanup_old_game_sessions(retention interval default interval '14 days')
returns table(deleted_sessions integer, detached_results integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  detached_count integer := 0;
  deleted_count integer := 0;
begin
  with old_sessions as (
    select id
    from public.game_sessions
    where coalesce(ended_at, started_at, created_at) < now() - retention
  ),
  detached as (
    update public.game_results gr
    set session_id = null
    where gr.session_id in (select id from old_sessions)
    returning 1
  )
  select count(*) into detached_count from detached;

  with old_sessions as (
    select id
    from public.game_sessions
    where coalesce(ended_at, started_at, created_at) < now() - retention
  ),
  deleted_players as (
    delete from public.game_players gp
    where gp.session_id in (select id from old_sessions)
    returning 1
  ),
  deleted as (
    delete from public.game_sessions gs
    where gs.id in (select id from old_sessions)
    returning 1
  )
  select count(*) into deleted_count from deleted;

  return query select deleted_count, detached_count;
end;
$$;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
    into existing_job_id
    from cron.job
   where jobname = 'cleanup-old-game-sessions';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end
$$;

select cron.schedule(
  'cleanup-old-game-sessions',
  '23 4 * * *',
  $$select public.cleanup_old_game_sessions(interval '14 days');$$
);
