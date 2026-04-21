alter table public.account_deletion_requests
  add column if not exists execution_result jsonb not null default '{}'::jsonb;

drop trigger if exists account_deletion_requests_updated_at on public.account_deletion_requests;
create trigger account_deletion_requests_updated_at
  before update on public.account_deletion_requests
  for each row execute function public.update_updated_at();

create table if not exists public.account_deletion_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.account_deletion_requests(id) on delete cascade,
  event_type text not null,
  actor_user_id uuid null references auth.users(id) on delete set null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint account_deletion_request_events_event_type_check
    check (event_type in ('requested', 'status_changed', 'execution_started', 'execution_completed', 'execution_failed'))
);

create index if not exists account_deletion_request_events_request_id_created_at_idx
  on public.account_deletion_request_events(request_id, created_at desc);

alter table public.account_deletion_request_events enable row level security;

drop policy if exists "account deletion request events admin select" on public.account_deletion_request_events;
create policy "account deletion request events admin select"
on public.account_deletion_request_events
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

drop policy if exists "account deletion request events admin insert" on public.account_deletion_request_events;
create policy "account deletion request events admin insert"
on public.account_deletion_request_events
for insert
to authenticated
with check (
  exists (
    select 1
    from public.admin_users a
    where a.user_id = auth.uid()
      and a.active = true
  )
);

insert into public.account_deletion_request_events (request_id, event_type, actor_user_id, message, details)
select
  r.id,
  'requested',
  null,
  case
    when r.source = 'in_app_authenticated' then 'Account deletion requested from the authenticated in-app flow.'
    else 'Account deletion requested from the public deletion request form.'
  end,
  jsonb_build_object('source', r.source)
from public.account_deletion_requests r
where not exists (
  select 1
  from public.account_deletion_request_events e
  where e.request_id = r.id
    and e.event_type = 'requested'
);
