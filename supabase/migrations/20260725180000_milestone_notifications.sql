-- Milestone unlocks move from toasts to the notification bell.
--
-- Milestones are detected client-side (src/lib/milestoneTracker.js) from the
-- same stats the profile renders, so the client writes its own notification
-- row. The insert policy is deliberately narrow: a user may only insert
-- milestone rows addressed to themselves, with no actor/deck/comment — social
-- notifications keep coming exclusively from SECURITY DEFINER paths.

alter table public.notifications
  add column if not exists milestone_id text;

-- 'milestone' is a new notification type; the existing CHECK only allowed the
-- social ones.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array['like', 'comment', 'follow', 'trade_proposal', 'milestone']));

-- Plain (non-partial) unique index: milestone_id is NULL on social rows and
-- NULLs never conflict, so this only constrains milestone rows — one per
-- milestone per user. Lets two devices detecting the same unlock race
-- harmlessly (the second insert is ignored on conflict).
create unique index if not exists notifications_user_milestone_idx
  on public.notifications (user_id, milestone_id);

drop policy if exists "insert own milestone notifications" on public.notifications;
create policy "insert own milestone notifications"
  on public.notifications
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and type = 'milestone'
    and milestone_id is not null
    and actor_id is null
    and deck_id is null
    and comment_id is null
  );

-- Surface milestone_id to the bell. Dropped first: adding an OUT column
-- changes the return type, which CREATE OR REPLACE refuses.
drop function if exists public.get_my_notifications(integer);
create function public.get_my_notifications(p_limit integer default 30)
returns table (
  id uuid,
  type text,
  actor_id uuid,
  actor_name text,
  deck_id uuid,
  deck_name text,
  comment_id uuid,
  milestone_id text,
  read boolean,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then return; end if;
  return query
    select n.id, n.type, n.actor_id, public.get_user_nickname(n.actor_id) as actor_name,
           n.deck_id, f.name as deck_name, n.comment_id, n.milestone_id, n.read, n.created_at
    from public.notifications n
    left join public.folders f on f.id = n.deck_id
    where n.user_id = v_caller
    order by n.created_at desc
    limit greatest(1, least(coalesce(p_limit,30), 100));
end; $function$;

-- Re-grant after the drop (a fresh function would otherwise fall back to the
-- default PUBLIC EXECUTE). It already returns nothing without auth.uid(), but
-- there's no reason for anon to hold the grant.
revoke all on function public.get_my_notifications(integer) from public, anon;
grant execute on function public.get_my_notifications(integer) to authenticated;
