drop policy if exists "Admins can update any user_settings" on public.user_settings;
create policy "Admins can update any user_settings"
  on public.user_settings
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.admin_users
      where admin_users.user_id = auth.uid()
        and admin_users.active = true
    )
  );

drop policy if exists "Admins can insert user_settings" on public.user_settings;
create policy "Admins can insert user_settings"
  on public.user_settings
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.admin_users
      where admin_users.user_id = auth.uid()
        and admin_users.active = true
    )
  );
