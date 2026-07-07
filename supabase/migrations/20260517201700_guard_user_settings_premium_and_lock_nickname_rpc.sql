-- P0: prevent clients from self-granting premium via direct UPDATE on user_settings.
-- Premium must only be flipped by service role (Stripe webhook) or by an active admin.
create or replace function public.guard_user_settings_premium()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.premium is distinct from OLD.premium then
    if auth.uid() is not null
       and not exists (
         select 1 from public.admin_users a
         where a.user_id = auth.uid() and a.active = true
       )
    then
      raise exception 'user_settings.premium is read-only for clients';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists user_settings_guard_premium on public.user_settings;
create trigger user_settings_guard_premium
before update on public.user_settings
for each row execute function public.guard_user_settings_premium();

-- P1: block anonymous enumeration of nicknames by uuid.
revoke execute on function public.get_user_nickname(uuid) from anon;;
