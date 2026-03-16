-- Run in Supabase SQL Editor to schedule daily price snapshots at 02:00 UTC
-- Requires pg_cron extension (enabled by default in Supabase)

select cron.schedule(
  'daily-price-snapshot',
  '0 2 * * *',  -- every day at 02:00 UTC
  $$
  select net.http_post(
    url := current_setting('app.supabase_url') || '/functions/v1/daily-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.supabase_anon_key')
    ),
    body := '{}'::jsonb
  )
  $$
);
