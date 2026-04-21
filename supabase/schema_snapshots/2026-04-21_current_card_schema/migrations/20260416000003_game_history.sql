create table if not exists public.tracked_games (
  id uuid primary key default gen_random_uuid(),
  source_session_id uuid references public.game_sessions(id) on delete set null,
  host_user_id uuid not null references auth.users,
  mode text not null,
  custom_life integer,
  player_count integer not null,
  is_shared boolean not null default false,
  players_json jsonb not null default '[]'::jsonb,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists tracked_games_host_idx
  on public.tracked_games (host_user_id, ended_at desc);

create index if not exists tracked_games_source_session_idx
  on public.tracked_games (source_session_id);

alter table public.tracked_games enable row level security;

alter table public.game_results
  add column if not exists game_id uuid references public.tracked_games(id) on delete set null;

alter table public.game_results
  add column if not exists player_name text;

alter table public.game_results
  add column if not exists player_color text;

alter table public.game_results
  add column if not exists final_life integer;

alter table public.game_results
  add column if not exists game_started_at timestamptz;

alter table public.game_results
  add column if not exists game_ended_at timestamptz;

alter table public.game_results
  add column if not exists players_json jsonb not null default '[]'::jsonb;

alter table public.game_results
  add column if not exists notes text not null default '';

alter table public.game_results
  add column if not exists updated_at timestamptz not null default now();

create index if not exists game_results_user_played_idx
  on public.game_results (user_id, played_at desc);

create index if not exists game_results_game_idx
  on public.game_results (game_id);

alter table public.game_results enable row level security;

drop policy if exists "Users update own game_results history" on public.game_results;
create policy "Users update own game_results history"
  on public.game_results for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own game_results history" on public.game_results;
create policy "Users delete own game_results history"
  on public.game_results for delete
  using (auth.uid() = user_id);

drop policy if exists "read tracked_games" on public.tracked_games;
create policy "read tracked_games"
  on public.tracked_games for select
  using (
    auth.uid() = host_user_id
    or exists (
      select 1
      from public.game_results gr
      where gr.game_id = tracked_games.id
        and gr.user_id = auth.uid()
    )
  );

drop policy if exists "insert tracked_games" on public.tracked_games;
create policy "insert tracked_games"
  on public.tracked_games for insert
  with check (auth.uid() = host_user_id);

drop policy if exists "update tracked_games" on public.tracked_games;
create policy "update tracked_games"
  on public.tracked_games for update
  using (auth.uid() = host_user_id)
  with check (auth.uid() = host_user_id);

drop policy if exists "delete tracked_games" on public.tracked_games;
create policy "delete tracked_games"
  on public.tracked_games for delete
  using (auth.uid() = host_user_id);
