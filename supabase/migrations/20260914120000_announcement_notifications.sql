-- Let a client record an announcement notification for itself.
--
-- "What's New" only reaches someone who expands the collapsed panel on Home,
-- so a feature can ship and never be noticed. The notification bell is where
-- people already look for "something happened".
--
-- Mechanism reuses the milestone one exactly: the client inserts a row keyed by
-- a well-known id, and the existing UNIQUE (user_id, milestone_id) index makes
-- it idempotent, so every account gets each announcement at most once without a
-- fan-out job or a service-role broadcast. `milestone_id` is a generic text key
-- despite the name; announcements use an `announce:` prefix so the two families
-- can never collide.
--
-- A separate `announcement` TYPE rather than overloading 'milestone': the bell
-- renders "Milestone unlocked — <label>" for milestone rows, and a release note
-- is not a trophy. Widening the type here keeps the DB honest about what the
-- row is, which matters because this will recur for every release.
--
-- The rest of the guard is unchanged and deliberately strict: still only rows
-- addressed to the inserting user, still no actor/deck/comment, so this cannot
-- be used to write a notification into somebody else's bell.

drop policy if exists "insert own milestone notifications" on public.notifications;

create policy "insert own milestone notifications"
  on public.notifications for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and type in ('milestone', 'announcement')
    and milestone_id is not null
    and actor_id is null
    and deck_id is null
    and comment_id is null
  );
