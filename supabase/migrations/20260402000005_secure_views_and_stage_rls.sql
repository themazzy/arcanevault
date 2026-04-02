alter table public.card_prices_stage enable row level security;

revoke all on public.card_prices_stage from anon, authenticated;
revoke all on public.card_prices_stage from public;

alter view public.owned_cards_view set (security_invoker = true);
alter view public.deck_cards_view set (security_invoker = true);
alter view public.deck_allocations_view set (security_invoker = true);

revoke all on public.owned_cards_view from anon;
revoke all on public.deck_cards_view from anon;
revoke all on public.deck_allocations_view from anon;

grant select on public.owned_cards_view to authenticated;
grant select on public.deck_cards_view to authenticated;
grant select on public.deck_allocations_view to authenticated;
