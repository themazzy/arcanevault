alter table public.user_settings
  add column if not exists archive_background_seed bigint not null default 0,
  add column if not exists archive_background_locked jsonb not null default '[]'::jsonb,
  add column if not exists archive_background_collection_source jsonb,
  add column if not exists archive_background_blur numeric not null default 7,
  add column if not exists archive_background_saturation numeric not null default 0.86,
  add column if not exists archive_background_opacity numeric not null default 0.16;
