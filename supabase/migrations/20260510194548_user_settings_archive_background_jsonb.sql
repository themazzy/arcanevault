-- Phase 6.1 compatibility step: introduce the consolidated archive background
-- JSON column and backfill it from the legacy split columns. The legacy
-- columns stay for now so currently deployed clients keep working until the
-- new frontend is live everywhere.

alter table public.user_settings
  add column if not exists archive_background jsonb;

update public.user_settings
set archive_background = jsonb_build_object(
  'mode',              archive_background_mode,
  'cards',             archive_background_cards,
  'seed',              archive_background_seed,
  'locked',            archive_background_locked,
  'collection_source', archive_background_collection_source,
  'blur',              archive_background_blur,
  'saturation',        archive_background_saturation,
  'opacity',           archive_background_opacity
)
where archive_background is null;
