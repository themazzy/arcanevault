-- Code-scoped read RPCs for game and tournament lobbies. SECURITY DEFINER so
-- they can return rows even after we revoke anon SELECT on the underlying
-- tables. Callers must supply a 4+ char code, so there's no full-table dump.
create or replace function public.get_game_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.game_sessions%rowtype;
  v_players jsonb;
begin
  if p_code is null or length(p_code) < 4 then
    return jsonb_build_object('session', null, 'players', '[]'::jsonb);
  end if;
  select * into v_session
  from public.game_sessions
  where code = upper(p_code)
  limit 1;
  if not found then
    return jsonb_build_object('session', null, 'players', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.slot_index), '[]'::jsonb)
    into v_players
  from public.game_players p
  where p.session_id = v_session.id;
  return jsonb_build_object('session', to_jsonb(v_session), 'players', v_players);
end;
$$;

revoke execute on function public.get_game_by_code(text) from public;
grant  execute on function public.get_game_by_code(text) to anon, authenticated;

create or replace function public.get_tournament_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.tournament_sessions%rowtype;
  v_players jsonb;
begin
  if p_code is null or length(p_code) < 4 then
    return jsonb_build_object('session', null, 'players', '[]'::jsonb);
  end if;
  select * into v_session
  from public.tournament_sessions
  where code = upper(p_code)
  limit 1;
  if not found then
    return jsonb_build_object('session', null, 'players', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.slot_index), '[]'::jsonb)
    into v_players
  from public.tournament_players p
  where p.session_id = v_session.id;
  return jsonb_build_object('session', to_jsonb(v_session), 'players', v_players);
end;
$$;

revoke execute on function public.get_tournament_by_code(text) from public;
grant  execute on function public.get_tournament_by_code(text) to anon, authenticated;

-- Lock down SELECT to authenticated users only. Anon callers must now go
-- through the code-scoped RPCs above, which prevents bulk enumeration of
-- display names and deck names from the lobby tables.
drop policy if exists sessions_select on public.game_sessions;
create policy sessions_select
on public.game_sessions
for select
to authenticated
using (true);

drop policy if exists players_select on public.game_players;
create policy players_select
on public.game_players
for select
to authenticated
using (true);

drop policy if exists "read tournament sessions" on public.tournament_sessions;
create policy "read tournament sessions"
on public.tournament_sessions
for select
to authenticated
using (true);

drop policy if exists "read tournament players" on public.tournament_players;
create policy "read tournament players"
on public.tournament_players
for select
to authenticated
using (true);;
