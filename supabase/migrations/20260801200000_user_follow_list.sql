-- Follower / following lists for the profile header.
--
-- get_user_follow_stats already returns the two counts, but they were dead text:
-- there was no way to see WHO follows someone, so the app had no social
-- discovery surface at all. This backs the clickable counts.
--
-- Exposes only what a public profile already shows — nickname, accent, premium —
-- and deliberately never user_id or email. Rows without a nickname have no
-- public profile to link to, so they are excluded rather than rendered as an
-- unclickable blank.
create or replace function public.get_user_follow_list(
  p_username text,
  p_kind     text default 'followers',
  p_limit    int  default 100
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid    uuid;
  v_result jsonb;
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
             'nickname', us.nickname,
             'accent',   coalesce(us.profile_accent, ''),
             'premium',  coalesce(us.premium, false)
           )
           order by uf.created_at desc
         )
  into v_result
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
  limit p_limit;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

-- Public profiles are readable signed-out, so the lists must be too.
grant execute on function public.get_user_follow_list(text, text, int) to anon, authenticated;

notify pgrst, 'reload schema';
