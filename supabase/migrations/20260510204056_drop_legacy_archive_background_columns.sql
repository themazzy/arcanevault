-- The deployed frontend now syncs archive theme settings through the single
-- archive_background JSONB column. Preserve any rows that somehow still have a
-- null JSONB payload, then remove the legacy split columns.

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

alter table public.user_settings
  drop column if exists archive_background_mode,
  drop column if exists archive_background_cards,
  drop column if exists archive_background_seed,
  drop column if exists archive_background_locked,
  drop column if exists archive_background_collection_source,
  drop column if exists archive_background_blur,
  drop column if exists archive_background_saturation,
  drop column if exists archive_background_opacity;
