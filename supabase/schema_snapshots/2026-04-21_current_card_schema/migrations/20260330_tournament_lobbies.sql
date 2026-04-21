create table if not exists tournament_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  format_id text not null,
  structure_id text not null,
  mode text not null check (mode in ('duel', 'pod')),
  pod_size int not null default 4,
  match_format text not null default 'bo1' check (match_format in ('bo1', 'bo3')),
  total_rounds int not null default 3,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'completed', 'cancelled')),
  state jsonb,
  host_user_id uuid not null references auth.users,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tournament_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references tournament_sessions on delete cascade,
  slot_index int not null,
  slot_kind text not null check (slot_kind in ('app', 'guest')),
  display_name text not null default '',
  user_id uuid references auth.users,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists tournament_players_session_slot_idx
  on tournament_players(session_id, slot_index);

alter table tournament_sessions enable row level security;
alter table tournament_players enable row level security;

drop policy if exists "read tournament sessions" on tournament_sessions;
create policy "read tournament sessions"
  on tournament_sessions for select
  using (true);

drop policy if exists "insert tournament sessions" on tournament_sessions;
create policy "insert tournament sessions"
  on tournament_sessions for insert
  with check (auth.uid() = host_user_id);

drop policy if exists "update tournament sessions" on tournament_sessions;
create policy "update tournament sessions"
  on tournament_sessions for update
  using (auth.uid() = host_user_id);

drop policy if exists "delete tournament sessions" on tournament_sessions;
create policy "delete tournament sessions"
  on tournament_sessions for delete
  using (auth.uid() = host_user_id);

drop policy if exists "read tournament players" on tournament_players;
create policy "read tournament players"
  on tournament_players for select
  using (true);

drop policy if exists "insert tournament players" on tournament_players;
create policy "insert tournament players"
  on tournament_players for insert
  with check (
    exists (
      select 1 from tournament_sessions s
      where s.id = session_id and s.host_user_id = auth.uid()
    )
  );

drop policy if exists "claim tournament slots" on tournament_players;
create policy "claim tournament slots"
  on tournament_players for update
  using (
    (slot_kind = 'app' and (user_id is null or user_id = auth.uid()))
    or exists (
      select 1 from tournament_sessions s
      where s.id = session_id and s.host_user_id = auth.uid()
    )
  );
