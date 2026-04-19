alter table public.card_hashes
  add column if not exists phash_hex_full text;

alter table public.card_hashes
  drop column if exists hash_part_1,
  drop column if exists hash_part_2,
  drop column if exists hash_part_3,
  drop column if exists hash_part_4;
