alter table public.user_settings
  add column if not exists page_tips_seen jsonb not null default '{}'::jsonb;
