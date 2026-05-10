-- Follow up the remaining actionable performance advisor INFO items. These are
-- all straightforward FK lookup/delete paths, so keep them indexed.

create index if not exists account_deletion_request_events_request_id_idx
  on public.account_deletion_request_events (request_id);

create index if not exists deck_cards_category_id_idx
  on public.deck_cards (category_id);

create index if not exists game_results_game_id_idx
  on public.game_results (game_id);

create index if not exists game_results_user_id_idx
  on public.game_results (user_id);
