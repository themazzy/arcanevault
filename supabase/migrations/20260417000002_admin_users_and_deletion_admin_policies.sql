create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  note text null,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

drop policy if exists "admin users can read own row" on public.admin_users;
create policy "admin users can read own row"
on public.admin_users
for select
to authenticated
using (auth.uid() = user_id and active = true);

alter table public.account_deletion_requests
  add column if not exists processed_by uuid null references auth.users(id) on delete set null;

drop policy if exists "account deletion requests admin select" on public.account_deletion_requests;
create policy "account deletion requests admin select"
on public.account_deletion_requests
for select
to authenticated
using (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid()
      and a.active = true
  )
);

drop policy if exists "account deletion requests admin update" on public.account_deletion_requests;
create policy "account deletion requests admin update"
on public.account_deletion_requests
for update
to authenticated
using (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid()
      and a.active = true
  )
)
with check (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid()
      and a.active = true
  )
);
