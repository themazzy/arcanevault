-- Opt out of phone notifications without opting out of alerts entirely.
--
-- Separate from price_alerts_enabled on purpose: someone may well want the bell
-- to keep collecting alerts while their phone stays quiet. Folding the two into
-- one toggle would make "stop buzzing me" also mean "stop tracking".
--
-- No effect on web; the setting is only rendered under Capacitor.

alter table public.user_settings
  add column if not exists phone_notifications_enabled boolean not null default true;

comment on column public.user_settings.phone_notifications_enabled is
  'Raise price alerts as Android system notifications as well as in the bell. Has no effect on web — the setting is only shown under Capacitor.';
