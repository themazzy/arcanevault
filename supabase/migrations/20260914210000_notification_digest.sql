-- Let the background runner see social notifications without a user session.
--
-- The runner (public/runners/price-alerts.js) executes in its own context and
-- may not run for days. It cannot hold a Supabase session: access tokens expire
-- in an hour, and refreshing independently would ROTATE the refresh token and
-- can sign the user out of the app itself. That is not a risk worth taking to
-- deliver a notification.
--
-- So: a per-user device key, and a SECURITY DEFINER function that resolves it.
-- The key is a v4 uuid — 122 bits, not guessable — and it is revocable by
-- updating the column. What it grants is deliberately narrow: recent
-- notification metadata and nothing else. No card data, no collection, no
-- email, no session.
--
-- Client-written types are excluded. milestone, announcement and price_alert
-- only ever appear because the app itself was running and already showed them,
-- so including them would notify a second time about something already seen.

alter table public.user_settings
  add column if not exists notification_key uuid not null default gen_random_uuid();

comment on column public.user_settings.notification_key is
  'Device key for get_notification_digest. Grants read of recent notification metadata only. Rotate to revoke every device.';

create or replace function public.get_notification_digest(
  p_key uuid,
  p_since timestamptz default null
)
returns table (
  type text,
  actor_name text,
  deck_name text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user uuid;
begin
  if p_key is null then return; end if;

  select s.user_id into v_user from public.user_settings s where s.notification_key = p_key;
  if v_user is null then return; end if;

  return query
    select n.type,
           public.get_user_nickname(n.actor_id) as actor_name,
           f.name as deck_name,
           n.created_at
    from public.notifications n
    left join public.folders f on f.id = n.deck_id
    where n.user_id = v_user
      and n.read = false
      -- See the note above: these three are written by the client, which has
      -- by definition already displayed them.
      and n.type not in ('milestone', 'announcement', 'price_alert')
      and (p_since is null or n.created_at > p_since)
    order by n.created_at desc
    limit 20;
end;
$$;

-- anon, because the runner authenticates with the anon key and the device key,
-- not with a user session. The function is the only thing that can turn that
-- key into data, and it scopes every row to the key's owner.
revoke execute on function public.get_notification_digest(uuid, timestamptz) from public;
grant execute on function public.get_notification_digest(uuid, timestamptz) to anon, authenticated;
