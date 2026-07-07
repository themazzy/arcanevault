-- Phase 2 — RLS performance rewrite (2026-05-08).
--
-- Two mechanical fixes that together clear ~69 perf advisor lints:
--   A. Wrap every `auth.uid()` reference inside policies as
--      `(select auth.uid())` so PG plans it once per query, not per row.
--      (`deck_categories` was already correct; left as-is.)
--   B. Consolidate overlapping permissive policies on app_config, deck_cards,
--      feedback, feedback_attachments, folders, shared_folders,
--      user_settings — one policy per (role, command) where overlap existed.
--
-- All semantics preserved. Rollback = restore from PITR or invert the
-- drop/create pairs. Original USING/CHECK clauses captured in commit
-- 20260508130000 description.

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ A. Wrap auth.uid() in (select …)                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── account_deletion_request_events ─────────────────────────────────────────
drop policy if exists "account deletion request events admin insert" on public.account_deletion_request_events;
drop policy if exists "account deletion request events admin select" on public.account_deletion_request_events;

create policy "account deletion request events admin insert"
  on public.account_deletion_request_events for insert to authenticated
  with check (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));

create policy "account deletion request events admin select"
  on public.account_deletion_request_events for select to authenticated
  using (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));

-- ── account_deletion_requests ───────────────────────────────────────────────
drop policy if exists "account deletion requests admin select" on public.account_deletion_requests;
drop policy if exists "account deletion requests admin update" on public.account_deletion_requests;
drop policy if exists "account deletion requests insert public" on public.account_deletion_requests;

create policy "account deletion requests admin select"
  on public.account_deletion_requests for select to authenticated
  using (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));

create policy "account deletion requests admin update"
  on public.account_deletion_requests for update to authenticated
  using (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true))
  with check (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));

create policy "account deletion requests insert public"
  on public.account_deletion_requests for insert to authenticated, anon
  with check (
    ((select auth.uid()) is null  and user_id is null               and source = 'public_request_form'::text)
    or
    ((select auth.uid()) is not null and user_id = (select auth.uid()) and source = 'in_app_authenticated'::text)
  );

-- ── admin_users ─────────────────────────────────────────────────────────────
drop policy if exists "admin users can read own row" on public.admin_users;
create policy "admin users can read own row"
  on public.admin_users for select to authenticated
  using ((select auth.uid()) = user_id and active = true);

-- ── card_prints (authenticated insert) ──────────────────────────────────────
-- (no auth.uid() in body, but wrap for consistency if added later — body is
--  pure schema-existence check; leave untouched.)

-- ── cards ───────────────────────────────────────────────────────────────────
drop policy if exists "own cards" on public.cards;
create policy "own cards"
  on public.cards for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── deck_allocations ────────────────────────────────────────────────────────
drop policy if exists "Users manage own deck_allocations" on public.deck_allocations;
create policy "Users manage own deck_allocations"
  on public.deck_allocations for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── folder_cards ────────────────────────────────────────────────────────────
drop policy if exists "own folder_cards" on public.folder_cards;
create policy "own folder_cards"
  on public.folder_cards for all
  using (exists (select 1 from public.folders
    where folders.id = folder_cards.folder_id and folders.user_id = (select auth.uid())))
  with check (exists (select 1 from public.folders
    where folders.id = folder_cards.folder_id and folders.user_id = (select auth.uid())));

-- ── list_items ──────────────────────────────────────────────────────────────
drop policy if exists "own list_items via folder" on public.list_items;
create policy "own list_items via folder"
  on public.list_items for all
  using (exists (select 1 from public.folders
    where folders.id = list_items.folder_id and folders.user_id = (select auth.uid())))
  with check (exists (select 1 from public.folders
    where folders.id = list_items.folder_id and folders.user_id = (select auth.uid())));

-- ── premium_purchases ───────────────────────────────────────────────────────
drop policy if exists "Users can read own premium purchases" on public.premium_purchases;
create policy "Users can read own premium purchases"
  on public.premium_purchases for select to authenticated
  using ((select auth.uid()) = user_id);

-- ── trade_log ───────────────────────────────────────────────────────────────
drop policy if exists "users manage own trades" on public.trade_log;
create policy "users manage own trades"
  on public.trade_log for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── game_sessions ───────────────────────────────────────────────────────────
drop policy if exists "sessions_delete" on public.game_sessions;
drop policy if exists "sessions_insert" on public.game_sessions;
drop policy if exists "sessions_select" on public.game_sessions;
drop policy if exists "sessions_update" on public.game_sessions;

create policy "sessions_delete" on public.game_sessions for delete using (host_user_id = (select auth.uid()));
create policy "sessions_insert" on public.game_sessions for insert with check (host_user_id = (select auth.uid()));
create policy "sessions_select" on public.game_sessions for select using (true);
create policy "sessions_update" on public.game_sessions for update using (host_user_id = (select auth.uid()));

-- ── game_players ────────────────────────────────────────────────────────────
drop policy if exists "players_insert" on public.game_players;
drop policy if exists "players_select" on public.game_players;
drop policy if exists "players_update" on public.game_players;

create policy "players_insert" on public.game_players for insert
  with check (exists (select 1 from public.game_sessions
    where game_sessions.id = game_players.session_id and game_sessions.host_user_id = (select auth.uid())));
create policy "players_select" on public.game_players for select using (true);
create policy "players_update" on public.game_players for update
  using (
    user_id is null
    or user_id = (select auth.uid())
    or exists (select 1 from public.game_sessions
        where game_sessions.id = game_players.session_id and game_sessions.host_user_id = (select auth.uid()))
  );

-- ── game_results ────────────────────────────────────────────────────────────
drop policy if exists "Users delete own game_results history" on public.game_results;
drop policy if exists "Users insert own game_results history" on public.game_results;
drop policy if exists "Users read own game_results history" on public.game_results;
drop policy if exists "Users update own game_results history" on public.game_results;

create policy "Users delete own game_results history" on public.game_results for delete
  using ((select auth.uid()) = user_id);

create policy "Users insert own game_results history" on public.game_results for insert
  with check (
    (select auth.uid()) = user_id
    or exists (
      select 1 from public.game_sessions gs
        join public.game_players gp on gp.session_id = gs.id and gp.user_id = game_results.user_id
      where gs.id = game_results.session_id and gs.host_user_id = (select auth.uid())
    )
  );

create policy "Users read own game_results history" on public.game_results for select
  using ((select auth.uid()) = user_id);

create policy "Users update own game_results history" on public.game_results for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── tracked_games ───────────────────────────────────────────────────────────
drop policy if exists "delete tracked_games" on public.tracked_games;
drop policy if exists "insert tracked_games" on public.tracked_games;
drop policy if exists "read tracked_games" on public.tracked_games;
drop policy if exists "update tracked_games" on public.tracked_games;

create policy "delete tracked_games" on public.tracked_games for delete using ((select auth.uid()) = host_user_id);
create policy "insert tracked_games" on public.tracked_games for insert with check ((select auth.uid()) = host_user_id);
create policy "read tracked_games" on public.tracked_games for select
  using (
    (select auth.uid()) = host_user_id
    or exists (select 1 from public.game_results gr
      where gr.game_id = tracked_games.id and gr.user_id = (select auth.uid()))
  );
create policy "update tracked_games" on public.tracked_games for update
  using ((select auth.uid()) = host_user_id)
  with check ((select auth.uid()) = host_user_id);

-- ── tournament_sessions ─────────────────────────────────────────────────────
drop policy if exists "delete tournament sessions" on public.tournament_sessions;
drop policy if exists "insert tournament sessions" on public.tournament_sessions;
drop policy if exists "read tournament sessions"   on public.tournament_sessions;
drop policy if exists "update tournament sessions" on public.tournament_sessions;

create policy "delete tournament sessions" on public.tournament_sessions for delete using ((select auth.uid()) = host_user_id);
create policy "insert tournament sessions" on public.tournament_sessions for insert with check ((select auth.uid()) = host_user_id);
create policy "read tournament sessions"   on public.tournament_sessions for select using (true);
create policy "update tournament sessions" on public.tournament_sessions for update using ((select auth.uid()) = host_user_id);

-- ── tournament_players ──────────────────────────────────────────────────────
drop policy if exists "claim tournament slots" on public.tournament_players;
drop policy if exists "insert tournament players" on public.tournament_players;
drop policy if exists "read tournament players"   on public.tournament_players;

create policy "claim tournament slots" on public.tournament_players for update
  using (
    (slot_kind = 'app' and (user_id is null or user_id = (select auth.uid())))
    or exists (select 1 from public.tournament_sessions s
        where s.id = tournament_players.session_id and s.host_user_id = (select auth.uid()))
  )
  with check (
    (slot_kind = 'app' and (user_id is null or user_id = (select auth.uid())))
    or exists (select 1 from public.tournament_sessions s
        where s.id = tournament_players.session_id and s.host_user_id = (select auth.uid()))
  );

create policy "insert tournament players" on public.tournament_players for insert
  with check (exists (select 1 from public.tournament_sessions s
    where s.id = tournament_players.session_id and s.host_user_id = (select auth.uid())));

create policy "read tournament players" on public.tournament_players for select using (true);

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ B. Permissive-policy consolidation                                       ║
-- ║                                                                          ║
-- ║ Pattern: where two policies overlapped on (role, command), either       ║
-- ║   (1) split the FOR-ALL "manage own" policy into IUD-only and merge     ║
-- ║       SELECT into a single combined policy; or                          ║
-- ║   (2) merge two SELECT policies via OR into one.                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── app_config ──────────────────────────────────────────────────────────────
-- read_all (SELECT, all roles) + write_admin (FOR ALL, authenticated) overlap on SELECT.
-- Restrict write_admin to insert/update/delete; read_all stays as the SELECT path.
drop policy if exists "write_admin" on public.app_config;
create policy "write_admin_insert" on public.app_config for insert to authenticated
  with check (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));
create policy "write_admin_update" on public.app_config for update to authenticated
  using (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true))
  with check (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));
create policy "write_admin_delete" on public.app_config for delete to authenticated
  using (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));

-- ── folders ─────────────────────────────────────────────────────────────────
-- own folders (FOR ALL, all roles) + Public read public deck folders (SELECT, all roles).
-- Split own into IUD; new combined SELECT policy covers owner + public-deck.
drop policy if exists "own folders" on public.folders;
drop policy if exists "Public read public deck folders" on public.folders;

create policy "folders_select" on public.folders for select
  using (
    user_id = (select auth.uid())
    or (
      type = any (array['deck'::text, 'builder_deck'::text])
      and (safe_jsonb(description) ->> 'is_public') = 'true'
    )
  );
create policy "folders_insert" on public.folders for insert with check ((select auth.uid()) = user_id);
create policy "folders_update" on public.folders for update
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "folders_delete" on public.folders for delete using ((select auth.uid()) = user_id);

-- ── deck_cards ──────────────────────────────────────────────────────────────
-- Public read deck_cards (SELECT) + Users manage own deck_cards (FOR ALL).
-- The public-read clause already includes the owner case, so own-manage
-- becomes IUD-only and the public-read serves SELECT for everyone.
drop policy if exists "Users manage own deck_cards" on public.deck_cards;

create policy "deck_cards_insert" on public.deck_cards for insert with check ((select auth.uid()) = user_id);
create policy "deck_cards_update" on public.deck_cards for update
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "deck_cards_delete" on public.deck_cards for delete using ((select auth.uid()) = user_id);

-- Rewrite the surviving SELECT policy to use (select auth.uid()).
drop policy if exists "Public read deck_cards" on public.deck_cards;
create policy "Public read deck_cards" on public.deck_cards for select
  using (exists (select 1 from public.folders f
    where f.id = deck_cards.deck_id
      and (f.user_id = (select auth.uid())
           or (safe_jsonb(f.description) ->> 'is_public') = 'true')));

-- ── shared_folders ──────────────────────────────────────────────────────────
-- own shared_folders (FOR ALL, all roles) + public read shared_folders (SELECT, all roles).
drop policy if exists "own shared_folders" on public.shared_folders;
drop policy if exists "public read shared_folders" on public.shared_folders;

create policy "shared_folders_select" on public.shared_folders for select using (true);
create policy "shared_folders_insert" on public.shared_folders for insert
  with check (exists (select 1 from public.folders
    where folders.id = shared_folders.folder_id and folders.user_id = (select auth.uid())));
create policy "shared_folders_update" on public.shared_folders for update
  using (exists (select 1 from public.folders
    where folders.id = shared_folders.folder_id and folders.user_id = (select auth.uid())))
  with check (exists (select 1 from public.folders
    where folders.id = shared_folders.folder_id and folders.user_id = (select auth.uid())));
create policy "shared_folders_delete" on public.shared_folders for delete
  using (exists (select 1 from public.folders
    where folders.id = shared_folders.folder_id and folders.user_id = (select auth.uid())));

-- ── feedback ────────────────────────────────────────────────────────────────
-- Merge admin-select + owner-select; keep separate insert paths (anon vs
-- authenticated have different role lists, no overlap there).
drop policy if exists "feedback admin select" on public.feedback;
drop policy if exists "feedback owner select" on public.feedback;
drop policy if exists "anon insert feedback" on public.feedback;
drop policy if exists "authenticated insert feedback" on public.feedback;
drop policy if exists "Admins can delete feedback" on public.feedback;

create policy "feedback_select" on public.feedback for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.admin_users a
        where a.user_id = (select auth.uid()) and a.active = true)
  );
create policy "feedback_insert_anon" on public.feedback for insert to anon with check (user_id is null);
create policy "feedback_insert_authed" on public.feedback for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "feedback_admin_delete" on public.feedback for delete to authenticated
  using (exists (select 1 from public.admin_users a
    where a.user_id = (select auth.uid()) and a.active = true));

-- ── feedback_attachments ────────────────────────────────────────────────────
drop policy if exists "feedback attachments admin select" on public.feedback_attachments;
drop policy if exists "owner read attachments" on public.feedback_attachments;
drop policy if exists "authenticated insert attachments" on public.feedback_attachments;
drop policy if exists "Users can delete their own attachments" on public.feedback_attachments;

create policy "feedback_attachments_select" on public.feedback_attachments for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (select 1 from public.admin_users a
        where a.user_id = (select auth.uid()) and a.active = true)
  );
create policy "feedback_attachments_insert" on public.feedback_attachments for insert to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);
create policy "feedback_attachments_delete" on public.feedback_attachments for delete to authenticated
  using (user_id = (select auth.uid()));

-- ── user_settings ───────────────────────────────────────────────────────────
-- own settings (FOR ALL, all roles) + Admins can insert (a, authed) +
-- Admins can update any (w, authed). Overlap on authed INSERT and UPDATE.
-- Split own into IUD; merge admin clauses into the same INSERT/UPDATE.
drop policy if exists "own settings" on public.user_settings;
drop policy if exists "Admins can insert user_settings" on public.user_settings;
drop policy if exists "Admins can update any user_settings" on public.user_settings;

create policy "user_settings_select" on public.user_settings for select
  using ((select auth.uid()) = user_id);

create policy "user_settings_insert" on public.user_settings for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    or exists (select 1 from public.admin_users a
        where a.user_id = (select auth.uid()) and a.active = true)
  );

create policy "user_settings_update" on public.user_settings for update to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (select 1 from public.admin_users a
        where a.user_id = (select auth.uid()) and a.active = true)
  )
  with check (
    (select auth.uid()) = user_id
    or exists (select 1 from public.admin_users a
        where a.user_id = (select auth.uid()) and a.active = true)
  );

create policy "user_settings_delete" on public.user_settings for delete
  using ((select auth.uid()) = user_id);
