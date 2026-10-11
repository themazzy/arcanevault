-- get_user_follow_list's `limit p_limit` never limited anything: it sat on the
-- outer select of a jsonb_agg, which only ever produces one row, so every call
-- returned the whole follower list regardless of p_limit. The limit now applies
-- to the rows before they are aggregated, and is clamped to 1..500 — the
-- function is anon-callable, so a caller-chosen limit is not a bound by itself.
create or replace function public.get_user_follow_list(
  p_username text,
  p_kind text default 'followers',
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid    uuid;
  v_result jsonb;
  v_limit  int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  if p_kind not in ('followers', 'following') then
    raise exception 'p_kind must be followers or following';
  end if;

  select user_id into v_uid
  from user_settings
  where lower(nickname) = lower(p_username)
  limit 1;

  if v_uid is null then
    return '[]'::jsonb;
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'nickname', r.nickname,
             'accent',   r.accent,
             'premium',  r.premium
           )
           order by r.created_at desc
         )
  into v_result
  from (
    select us.nickname,
           coalesce(us.profile_accent, '') as accent,
           coalesce(us.premium, false)     as premium,
           uf.created_at
    from user_follows uf
    join user_settings us
      on us.user_id = case when p_kind = 'followers'
                           then uf.follower_id
                           else uf.following_id
                      end
    where (case when p_kind = 'followers'
                then uf.following_id
                else uf.follower_id
           end) = v_uid
      and us.nickname is not null
      and btrim(us.nickname) <> ''
    order by uf.created_at desc
    limit v_limit
  ) r;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;
