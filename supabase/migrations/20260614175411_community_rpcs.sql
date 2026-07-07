-- Public-read + notification RPCs for the community layer. All SECURITY DEFINER
-- and gated on the deck's public flag (mirrors get_deck_og_meta).

create or replace function public.get_deck_social(p_deck_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid; v_meta jsonb; v_caller uuid := auth.uid(); v_likes int; v_comments int;
begin
  select user_id, public.safe_jsonb(description) into v_owner, v_meta
  from public.folders where id = p_deck_id;
  if v_owner is null then return null; end if;
  if coalesce(v_meta->>'is_public','false') <> 'true' and v_caller is distinct from v_owner then
    return null;
  end if;
  select count(*) into v_likes    from public.deck_likes    where deck_id = p_deck_id;
  select count(*) into v_comments from public.deck_comments where deck_id = p_deck_id;
  return jsonb_build_object(
    'like_count',    v_likes,
    'comment_count', v_comments,
    'viewer_liked',  v_caller is not null and exists(select 1 from public.deck_likes where deck_id=p_deck_id and user_id=v_caller),
    'is_owner',      v_caller is not distinct from v_owner
  );
end; $$;
grant execute on function public.get_deck_social(uuid) to anon, authenticated;

create or replace function public.get_deck_comments(p_deck_id uuid)
returns table(id uuid, user_id uuid, username text, body text, created_at timestamptz, can_delete boolean)
language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid; v_meta jsonb; v_caller uuid := auth.uid();
begin
  select f.user_id, public.safe_jsonb(f.description) into v_owner, v_meta
  from public.folders f where f.id = p_deck_id;
  if v_owner is null then return; end if;
  if coalesce(v_meta->>'is_public','false') <> 'true' and v_caller is distinct from v_owner then return; end if;
  return query
    select dc.id, dc.user_id, public.get_user_nickname(dc.user_id) as username, dc.body, dc.created_at,
           (v_caller is not null and (v_caller = dc.user_id or v_caller = v_owner)) as can_delete
    from public.deck_comments dc
    where dc.deck_id = p_deck_id
    order by dc.created_at asc;
end; $$;
grant execute on function public.get_deck_comments(uuid) to anon, authenticated;

create or replace function public.get_user_follow_stats(p_username text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_uid uuid; v_caller uuid := auth.uid(); v_followers int; v_following int;
begin
  select user_id into v_uid from public.user_settings where lower(nickname)=lower(p_username) limit 1;
  if v_uid is null then return null; end if;
  select count(*) into v_followers from public.user_follows where following_id = v_uid;
  select count(*) into v_following from public.user_follows where follower_id  = v_uid;
  return jsonb_build_object(
    'user_id',          v_uid,
    'follower_count',   v_followers,
    'following_count',  v_following,
    'viewer_following', v_caller is not null and exists(select 1 from public.user_follows where follower_id=v_caller and following_id=v_uid),
    'is_self',          v_caller is not distinct from v_uid
  );
end; $$;
grant execute on function public.get_user_follow_stats(text) to anon, authenticated;

create or replace function public.get_my_notifications(p_limit int default 30)
returns table(id uuid, type text, actor_id uuid, actor_name text, deck_id uuid, deck_name text, comment_id uuid, read boolean, created_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
declare v_caller uuid := auth.uid();
begin
  if v_caller is null then return; end if;
  return query
    select n.id, n.type, n.actor_id, public.get_user_nickname(n.actor_id) as actor_name,
           n.deck_id, f.name as deck_name, n.comment_id, n.read, n.created_at
    from public.notifications n
    left join public.folders f on f.id = n.deck_id
    where n.user_id = v_caller
    order by n.created_at desc
    limit greatest(1, least(coalesce(p_limit,30), 100));
end; $$;
grant execute on function public.get_my_notifications(int) to authenticated;

create or replace function public.mark_all_notifications_read()
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.notifications set read = true where user_id = auth.uid() and not read;
end; $$;
grant execute on function public.mark_all_notifications_read() to authenticated;

create or replace function public.list_public_decks(p_sort text default 'popular', p_format text default null, p_limit int default 24, p_offset int default 0)
returns table(deck_id uuid, name text, username text, format text, commander text, art text, total_cards int, like_count int, comment_count int, created_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
begin
  return query
  with pub as (
    select f.id, f.name, f.user_id, f.created_at, meta
    from public.folders f
    cross join lateral public.safe_jsonb(f.description) meta
    where f.type in ('deck','builder_deck')
      and meta->>'is_public' = 'true'
      and not (f.type='deck' and coalesce(meta->>'linked_builder_id','') <> '')
      and (p_format is null or meta->>'format' = p_format)
  )
  select p.id, p.name, public.get_user_nickname(p.user_id) as username,
         nullif(p.meta->>'format','') as format,
         nullif(coalesce(
           (select string_agg(c->>'name', ' + ') from jsonb_array_elements(coalesce(p.meta->'commanders','[]'::jsonb)) c where coalesce(c->>'name','')<>''),
           p.meta->>'commanderName'), '') as commander,
         p.meta->>'coverArtUri' as art,
         (select coalesce(sum(dc.qty),0)::int from public.deck_cards dc where dc.deck_id = p.id) as total_cards,
         (select count(*)::int from public.deck_likes dl where dl.deck_id = p.id) as like_count,
         (select count(*)::int from public.deck_comments dcm where dcm.deck_id = p.id) as comment_count,
         p.created_at
  from pub p
  order by
    case when p_sort='recent' then p.created_at end desc nulls last,
    (select count(*) from public.deck_likes dl where dl.deck_id = p.id) desc,
    p.created_at desc
  limit greatest(1, least(coalesce(p_limit,24), 60)) offset greatest(0, coalesce(p_offset,0));
end; $$;
grant execute on function public.list_public_decks(text,text,int,int) to anon, authenticated;

notify pgrst, 'reload schema';
