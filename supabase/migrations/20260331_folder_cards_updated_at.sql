alter table public.folder_cards
  add column if not exists updated_at timestamptz default now();

create index if not exists folder_cards_updated_at_idx
  on public.folder_cards(updated_at);

drop trigger if exists folder_cards_updated_at on public.folder_cards;
create trigger folder_cards_updated_at
  before update on public.folder_cards
  for each row execute function update_updated_at();
