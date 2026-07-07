-- Community layer: likes, comments, follows, notifications.
-- Public read happens through SECURITY DEFINER RPCs (see community_rpcs); these
-- tables are written directly by the owning user under RLS.

-- ── deck_likes ──────────────────────────────────────────────────────────────
create table if not exists public.deck_likes (
  deck_id    uuid not null references public.folders(id) on delete cascade,
  user_id    uuid not null references auth.users(id)    on delete cascade,
  created_at timestamptz not null default now(),
  primary key (deck_id, user_id)
);
create index if not exists deck_likes_deck_idx on public.deck_likes (deck_id);
alter table public.deck_likes enable row level security;
create policy "view own likes" on public.deck_likes for select to authenticated
  using (user_id = (select auth.uid()));
create policy "like public decks" on public.deck_likes for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.folders f
    where f.id = deck_id and public.safe_jsonb(f.description)->>'is_public' = 'true'));
create policy "unlike own" on public.deck_likes for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.deck_likes from anon, public;
grant select, insert, delete on public.deck_likes to authenticated;

-- ── deck_comments ───────────────────────────────────────────────────────────
create table if not exists public.deck_comments (
  id         uuid primary key default gen_random_uuid(),
  deck_id    uuid not null references public.folders(id) on delete cascade,
  user_id    uuid not null references auth.users(id)    on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  constraint deck_comments_body_len check (char_length(btrim(body)) between 1 and 2000)
);
create index if not exists deck_comments_deck_idx on public.deck_comments (deck_id, created_at);
alter table public.deck_comments enable row level security;
create policy "comment on public decks" on public.deck_comments for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.folders f
    where f.id = deck_id and public.safe_jsonb(f.description)->>'is_public' = 'true'));
create policy "delete own or deck owner" on public.deck_comments for delete to authenticated
  using (user_id = (select auth.uid()) or exists (
    select 1 from public.folders f where f.id = deck_id and f.user_id = (select auth.uid())));
revoke all on public.deck_comments from anon, public;
grant select, insert, delete on public.deck_comments to authenticated;

-- ── user_follows ────────────────────────────────────────────────────────────
create table if not exists public.user_follows (
  follower_id  uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint no_self_follow check (follower_id <> following_id)
);
create index if not exists user_follows_following_idx on public.user_follows (following_id);
alter table public.user_follows enable row level security;
create policy "view own follows" on public.user_follows for select to authenticated
  using (follower_id = (select auth.uid()));
create policy "follow" on public.user_follows for insert to authenticated
  with check (follower_id = (select auth.uid()));
create policy "unfollow" on public.user_follows for delete to authenticated
  using (follower_id = (select auth.uid()));
revoke all on public.user_follows from anon, public;
grant select, insert, delete on public.user_follows to authenticated;

-- ── notifications ───────────────────────────────────────────────────────────
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,   -- recipient
  actor_id   uuid references auth.users(id) on delete set null,
  type       text not null check (type in ('like','comment','follow')),
  deck_id    uuid references public.folders(id) on delete cascade,
  comment_id uuid references public.deck_comments(id) on delete cascade,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "read own notifications" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "update own notifications" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own notifications" on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));
-- No insert policy: rows are created only by the SECURITY DEFINER triggers below.
revoke all on public.notifications from anon, public;
grant select, update, delete on public.notifications to authenticated;

-- ── notification triggers ─────────────────────────────────────────────────────
create or replace function public.notify_on_deck_like()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.folders where id = NEW.deck_id;
  if v_owner is not null and v_owner <> NEW.user_id then
    insert into public.notifications(user_id, actor_id, type, deck_id)
    values (v_owner, NEW.user_id, 'like', NEW.deck_id);
  end if;
  return NEW;
end; $$;
revoke execute on function public.notify_on_deck_like() from public, anon, authenticated;
drop trigger if exists trg_notify_deck_like on public.deck_likes;
create trigger trg_notify_deck_like after insert on public.deck_likes
  for each row execute function public.notify_on_deck_like();

create or replace function public.notify_on_deck_comment()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.folders where id = NEW.deck_id;
  if v_owner is not null and v_owner <> NEW.user_id then
    insert into public.notifications(user_id, actor_id, type, deck_id, comment_id)
    values (v_owner, NEW.user_id, 'comment', NEW.deck_id, NEW.id);
  end if;
  return NEW;
end; $$;
revoke execute on function public.notify_on_deck_comment() from public, anon, authenticated;
drop trigger if exists trg_notify_deck_comment on public.deck_comments;
create trigger trg_notify_deck_comment after insert on public.deck_comments
  for each row execute function public.notify_on_deck_comment();

create or replace function public.notify_on_follow()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.notifications(user_id, actor_id, type)
  values (NEW.following_id, NEW.follower_id, 'follow');
  return NEW;
end; $$;
revoke execute on function public.notify_on_follow() from public, anon, authenticated;
drop trigger if exists trg_notify_follow on public.user_follows;
create trigger trg_notify_follow after insert on public.user_follows
  for each row execute function public.notify_on_follow();

notify pgrst, 'reload schema';
