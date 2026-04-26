-- Policy cleanup based on live pg_policies audit.
-- Drops stale, duplicate, and incorrectly-scoped policies, then ensures
-- the correct canonical set is in place.

-- ── cards ─────────────────────────────────────────────────────────────────────
-- "anon read cards" lets unauthenticated callers read any user's cards.
-- "own cards" (ALL) already covers the owner; no anon access is needed.
drop policy if exists "anon read cards" on public.cards;

-- ── deck_cards ────────────────────────────────────────────────────────────────
-- "Public read deck cards" (anon, USING true) and "anon read deck_cards" are
-- old policies superseded by the folder-scoped "Public read deck_cards" (000009).
drop policy if exists "Public read deck cards"  on public.deck_cards;
drop policy if exists "anon read deck_cards"     on public.deck_cards;

-- ── folder_cards ──────────────────────────────────────────────────────────────
-- "anon read folder_cards" exposes all binder/deck placements to unauthenticated
-- callers. "own folder_cards" (ALL) is the only policy needed.
drop policy if exists "anon read folder_cards" on public.folder_cards;

-- ── folders ───────────────────────────────────────────────────────────────────
-- Three stale policies predate the is_public gate introduced in 20260426000003.
-- "own folders" handles the owner; we replace the others with the is_public check.
drop policy if exists "Public read deck folders"  on public.folders;
drop policy if exists "Public read builder decks" on public.folders;
drop policy if exists "anon read folders"          on public.folders;

-- Canonical public read: deck/builder_deck folders explicitly marked is_public.
drop policy if exists "Public read public deck folders" on public.folders;
create policy "Public read public deck folders"
  on public.folders for select
  using (
    type in ('deck', 'builder_deck')
    and public.safe_jsonb(description) ->> 'is_public' = 'true'
  );

-- ── feedback_attachments ──────────────────────────────────────────────────────
-- Multiple waves of migrations left duplicate SELECT and INSERT policies.
-- Keep: "owner read attachments", "authenticated insert attachments",
--       "feedback attachments admin select", "Users can delete their own attachments".
-- Drop everything else.
drop policy if exists "Users can insert their own attachments"  on public.feedback_attachments;
drop policy if exists "Users can read their own attachments"    on public.feedback_attachments;
drop policy if exists "Users can update their own attachments"  on public.feedback_attachments;
drop policy if exists "feedback attachments insert own"         on public.feedback_attachments;
drop policy if exists "feedback attachments owner select"       on public.feedback_attachments;

-- ── game_results ──────────────────────────────────────────────────────────────
-- "insert results" and "read own results" are older duplicates of the canonical
-- "Users insert/read own game_results history" policies.
drop policy if exists "insert results"    on public.game_results;
drop policy if exists "read own results"  on public.game_results;

-- ── list_items ────────────────────────────────────────────────────────────────
-- "list_items_own_insert_update_select" is an older policy superseded by
-- "own list_items via folder" (scoped via folder ownership, not user_id).
drop policy if exists "list_items_own_insert_update_select" on public.list_items;

-- ── user_settings ─────────────────────────────────────────────────────────────
-- "Users can insert own settings" and "Users can update own settings" are fully
-- covered by the existing "own settings" (ALL) policy.
drop policy if exists "Users can insert own settings" on public.user_settings;
drop policy if exists "Users can update own settings" on public.user_settings;

-- ── app_config ────────────────────────────────────────────────────────────────
-- "write_authenticated" is granted to the {public} role, which includes anon.
-- That means unauthenticated callers can INSERT/UPDATE/DELETE config rows.
-- Re-create scoped to {authenticated} only.
drop policy if exists "write_authenticated" on public.app_config;
create policy "write_authenticated"
  on public.app_config for all
  to authenticated
  using (true)
  with check (true);
