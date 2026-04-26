-- NEW-2: Defensive baseline — ensure RLS is enabled on all core tables.
-- Some tables rely on policies written in earlier migrations but never had an
-- explicit ENABLE ROWLEVEL SECURITY in their creation migration. This migration
-- is idempotent: enabling RLS on a table that already has it is a no-op.

alter table public.cards              enable row level security;
alter table public.folders            enable row level security;
alter table public.folder_cards       enable row level security;
alter table public.deck_cards         enable row level security;
alter table public.deck_allocations   enable row level security;
alter table public.user_settings      enable row level security;
alter table public.list_items         enable row level security;
alter table public.game_sessions      enable row level security;
alter table public.game_players       enable row level security;
alter table public.card_prices        enable row level security;
alter table public.card_prints        enable row level security;
alter table public.card_hashes        enable row level security;
alter table public.feedback           enable row level security;
alter table public.feedback_attachments enable row level security;
alter table public.tournament_sessions  enable row level security;
alter table public.tournament_players   enable row level security;
