
create table trade_log (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users not null,
  traded_at        timestamptz not null default now(),
  partner_name     text,
  notes            text,
  giving           jsonb not null default '[]',
  receiving        jsonb not null default '[]',
  giving_value     numeric not null default 0,
  receiving_value  numeric not null default 0
);

alter table trade_log enable row level security;

create policy "users manage own trades"
  on trade_log for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index trade_log_user_traded on trade_log (user_id, traded_at desc);
;
