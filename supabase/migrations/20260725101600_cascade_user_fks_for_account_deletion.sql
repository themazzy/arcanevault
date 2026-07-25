-- Account deletion also has to survive users who actually have history.
--
-- Six foreign keys to auth.users were still ON DELETE NO ACTION, so deleting the
-- auth user for anyone with a recorded game, tournament seat or trade would fail
-- with a foreign key violation (again surfaced as GoTrue's "Database error
-- deleting user"). Every other user-owned table already cascades; align these.
--
-- These rows are all user-owned records, so erasure is the correct GDPR
-- behaviour: a deleted account takes its own game results, tracked games, trade
-- log, tournament seats, hosted tournaments and feedback with it.
alter table public.feedback
  drop constraint feedback_user_id_fkey,
  add constraint feedback_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.game_results
  drop constraint game_results_user_id_fkey,
  add constraint game_results_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.tournament_players
  drop constraint tournament_players_user_id_fkey,
  add constraint tournament_players_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.tournament_sessions
  drop constraint tournament_sessions_host_user_id_fkey,
  add constraint tournament_sessions_host_user_id_fkey
    foreign key (host_user_id) references auth.users(id) on delete cascade;

alter table public.tracked_games
  drop constraint tracked_games_host_user_id_fkey,
  add constraint tracked_games_host_user_id_fkey
    foreign key (host_user_id) references auth.users(id) on delete cascade;

alter table public.trade_log
  drop constraint trade_log_user_id_fkey,
  add constraint trade_log_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;
