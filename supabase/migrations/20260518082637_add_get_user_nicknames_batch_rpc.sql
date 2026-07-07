-- Batched counterpart to get_user_nickname(uuid).
-- Returns (user_id, nickname) rows for every id in the input array that has a
-- nickname set. Used by Builder.jsx community-decks tab to avoid N round trips.
create or replace function public.get_user_nicknames(p_user_ids uuid[])
returns table(user_id uuid, nickname text)
language sql
security definer
set search_path to 'public'
as $$
  select us.user_id, us.nickname
  from user_settings us
  where us.user_id = any(p_user_ids)
    and us.nickname is not null
    and us.nickname <> '';
$$;

revoke all on function public.get_user_nicknames(uuid[]) from public;
grant execute on function public.get_user_nicknames(uuid[]) to anon, authenticated;;
