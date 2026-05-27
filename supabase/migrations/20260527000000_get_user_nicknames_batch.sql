-- Batch variant of get_user_nickname: returns nicknames for many users in one round trip.
-- Used by Builder.jsx community decks view to label deck creators without N+1 RPCs.
create or replace function get_user_nicknames(p_user_ids uuid[])
returns table (user_id uuid, nickname text)
language sql
security definer
set search_path = public
as $$
  select us.user_id, us.nickname
  from user_settings us
  where us.user_id = any(p_user_ids)
    and us.nickname is not null
    and us.nickname <> '';
$$;

revoke execute on function get_user_nicknames(uuid[]) from public;
grant  execute on function get_user_nicknames(uuid[]) to authenticated;
