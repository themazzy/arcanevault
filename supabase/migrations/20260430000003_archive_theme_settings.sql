alter table public.user_settings
  add column if not exists archive_background_mode text not null default 'random',
  add column if not exists archive_background_cards jsonb not null default '[]'::jsonb;
