-- Replace currency + price_type columns with single price_source
alter table user_settings
  add column if not exists price_source text default 'cardmarket_trend';

-- Migrate existing data
update user_settings
set price_source = case
  when currency = 'USD' then 'tcgplayer_market'
  else 'cardmarket_trend'
end;

-- Old columns can be kept for now (no breaking change), or dropped:
-- alter table user_settings drop column if exists currency;
-- alter table user_settings drop column if exists price_type;

-- Add display_currency column
alter table user_settings
  add column if not exists display_currency text default 'EUR';
