create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null references auth.users(id) on delete set null,
  user_email text not null,
  request_reason text null,
  source text not null default 'public_request_form',
  status text not null default 'pending',
  request_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz null,
  admin_notes text null,
  constraint account_deletion_requests_status_check
    check (status in ('pending', 'in_review', 'completed', 'rejected')),
  constraint account_deletion_requests_source_check
    check (source in ('public_request_form', 'in_app_authenticated'))
);

alter table public.account_deletion_requests enable row level security;

create index if not exists account_deletion_requests_created_at_idx
  on public.account_deletion_requests(created_at desc);

create index if not exists account_deletion_requests_user_id_idx
  on public.account_deletion_requests(user_id);

create index if not exists account_deletion_requests_user_email_idx
  on public.account_deletion_requests(lower(user_email));

drop policy if exists "account deletion requests insert public" on public.account_deletion_requests;
create policy "account deletion requests insert public"
on public.account_deletion_requests
for insert
to anon, authenticated
with check (
  (
    auth.uid() is null
    and user_id is null
    and source = 'public_request_form'
  )
  or
  (
    auth.uid() is not null
    and user_id = auth.uid()
    and source = 'in_app_authenticated'
  )
);
