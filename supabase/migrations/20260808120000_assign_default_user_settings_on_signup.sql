-- Give every new user a settings row with a generated nickname at signup.
--
-- Background: the Setup Wizard used to own this. Commit 188a271 (2026-05-13)
-- added a Profile step that assigned a generated handle even when the user
-- skipped it; commit c3bf67e (2026-07-20, "Improve onboarding dashboard and
-- deck workflows") deleted the whole step as collateral in an onboarding
-- rewrite. Since then the wizard writes user_settings only from its per-control
-- onChange handlers, so a user who clicks Next through every step without
-- touching a preference never causes a single write. Result: all 4 users who
-- registered after that commit have no user_settings row and no nickname, and
-- their public decks render ownerless in the community browser.
--
-- Doing this in the client would only cover users who reach the wizard. The
-- trigger covers every signup path including OAuth, so the guarantee holds
-- regardless of what the front end does.
--
-- SAFETY: a raising trigger on auth.users breaks signup outright ("Database
-- error saving new user"). Every failure mode here is therefore swallowed —
-- nickname collisions retry, and anything else is logged as a warning and
-- ignored. A user with no nickname is a cosmetic problem; a user who cannot
-- register is not.

-- Word lists mirror src/lib/nicknameGenerator.js. Keep them in sync if either
-- side changes. Format: <Adjective><Noun><two digits>, e.g. "MysticGoblin47".
-- Words are <=10 chars so the longest result stays inside the 24-char cap the
-- Settings nickname field enforces.
create or replace function public.generate_nickname(p_digits int default 2)
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $function$
declare
  v_adjectives constant text[] := array[
    'Arcane','Ancient','Azure','Crimson','Eternal','Feral','Gilded','Mystic',
    'Spectral','Verdant','Radiant','Savage','Cursed','Hallowed','Infernal',
    'Primal','Astral','Blighted','Celestial','Draconic','Ember','Frostbound',
    'Grim','Ironclad','Lunar','Molten','Necrotic','Obsidian','Phantom',
    'Runic','Stormborn','Thornclad','Umbral','Valiant','Withered','Wandering',
    'Boundless','Twilight','Vengeful','Undying'
  ];
  v_nouns constant text[] := array[
    'Goblin','Dragon','Sphinx','Phoenix','Hydra','Specter','Wraith','Golem',
    'Elemental','Angel','Demon','Vampire','Zombie','Merfolk','Knight','Wizard',
    'Druid','Shaman','Warden','Sentinel','Leviathan','Behemoth','Gargoyle',
    'Basilisk','Chimera','Griffin','Wyvern','Lich','Spellblade','Bloodmage',
    'Runemaster','Beast','Serpent','Treefolk','Horror','Avatar','Familiar',
    'Warlock','Champion','Conjurer','Oracle','Reaver','Saproling','Construct'
  ];
  v_digits int := greatest(coalesce(p_digits, 2), 1);
begin
  return v_adjectives[1 + floor(random() * array_length(v_adjectives, 1))::int]
      || v_nouns[1 + floor(random() * array_length(v_nouns, 1))::int]
      || lpad(floor(random() * (10::numeric ^ v_digits))::bigint::text, v_digits, '0');
end;
$function$;

-- Create the settings row, or fill in a blank nickname on a row that already
-- exists. Returns the nickname in force, or null if one could not be assigned.
--
-- The explicit column values are NOT redundant with the table's column
-- defaults: three of them disagree with the client's DEFAULTS in
-- SettingsContext.jsx, and the client merges as {...DEFAULTS, ...remoteRow},
-- so whatever is stored wins. Materialising a row therefore CHANGES behaviour
-- for a new user unless these are written explicitly:
--
--   anonymize_email   column default false  vs  client default true
--   default_grouping  column default 'type' vs  client default 'category'
--   profile_config    column default has deck_count/decks disabled,
--                     client DEFAULT_BENTO_CONFIG has both enabled
--
-- anonymize_email is the one that matters: relying on the column default would
-- silently turn off email anonymisation for every new user, which is a privacy
-- regression, not a cosmetic one. The stale column defaults are left alone —
-- changing them would not affect existing rows and this function is now the
-- only thing that inserts one.
create or replace function public.assign_default_user_settings(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_existing text;
  v_has_row  boolean;
  v_nick     text;
begin
  if p_user_id is null then return null; end if;

  select nullif(btrim(coalesce(us.nickname, '')), ''), true
    into v_existing, v_has_row
  from public.user_settings us
  where us.user_id = p_user_id;

  -- Never touch a nickname the user already has.
  if coalesce(v_has_row, false) and v_existing is not null then
    return v_existing;
  end if;

  -- Retry on collision against idx_user_settings_nickname_unique. The last few
  -- attempts widen to 4 digits so a saturated <Adjective><Noun>NN space (1760
  -- pairs x 100) cannot loop forever.
  for i in 1..12 loop
    v_nick := public.generate_nickname(case when i > 8 then 4 else 2 end);
    begin
      insert into public.user_settings as us (
        user_id, nickname, anonymize_email, default_grouping, profile_config
      )
      values (
        p_user_id, v_nick, true, 'category',
        '{"blocks": [{"id": "bio", "enabled": true}, {"id": "total", "enabled": true},
                     {"id": "unique", "enabled": true}, {"id": "since", "enabled": true},
                     {"id": "value", "enabled": false}, {"id": "deck_count", "enabled": true},
                     {"id": "crown", "enabled": false}, {"id": "decks", "enabled": true}]}'::jsonb
      )
      on conflict (user_id) do update
        set nickname = excluded.nickname
        -- Only fills a blank. Other columns are left as the user has them.
        where btrim(coalesce(us.nickname, '')) = '';
      return v_nick;
    exception when unique_violation then
      null; -- nickname taken, draw another
    end;
  end loop;

  raise warning 'assign_default_user_settings: no free nickname for % after 12 attempts', p_user_id;
  return null;
end;
$function$;

revoke execute on function public.generate_nickname(int) from public;
revoke execute on function public.assign_default_user_settings(uuid) from public;

create or replace function public.handle_new_user_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  begin
    perform public.assign_default_user_settings(new.id);
  exception when others then
    -- Signup must succeed even if this does not.
    raise warning 'handle_new_user_settings failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

revoke execute on function public.handle_new_user_settings() from public;

drop trigger if exists on_auth_user_created_settings on auth.users;
create trigger on_auth_user_created_settings
after insert on auth.users
for each row execute function public.handle_new_user_settings();

-- Backfill everyone currently missing a nickname: the 4 users who registered
-- after the wizard step was deleted, plus 12 older accounts that skipped it.
do $backfill$
declare
  r record;
begin
  for r in
    select u.id
    from auth.users u
    left join public.user_settings us on us.user_id = u.id
    where us.user_id is null or btrim(coalesce(us.nickname, '')) = ''
    order by u.created_at
  loop
    perform public.assign_default_user_settings(r.id);
  end loop;
end;
$backfill$;

notify pgrst, 'reload schema';
