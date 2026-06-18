-- Trade Post backend: a per-user, shareable two-sided trade listing.
--   * "Haves"  = owned cards placed in the user's protected "For Trade" binder
--     (a normal binder folder flagged isTradeBinder in its description meta).
--   * "Wants"  = items from the wishlists the user chooses to feature.
-- The post is opt-in (user_settings.trade_open) and viewable by anyone; signed-in
-- viewers can submit trade proposals, which land in the owner's inbox + bell.

-- ── Opt-in flag + featured-wishlist selection on the single user_settings row ──
alter table public.user_settings
  add column if not exists trade_open  boolean not null default false,
  add column if not exists trade_wants jsonb   not null default '[]'::jsonb;

-- ── Proposals ────────────────────────────────────────────────────────────────
create table if not exists public.trade_proposals (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  proposer_id uuid not null references auth.users(id) on delete cascade,
  requested   jsonb not null default '[]'::jsonb,  -- owner's haves the proposer wants
  offered     jsonb not null default '[]'::jsonb,  -- cards the proposer offers
  note        text,
  status      text not null default 'pending'
              check (status in ('pending','accepted','declined','cancelled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists trade_proposals_owner_idx    on public.trade_proposals (owner_id, created_at desc);
create index if not exists trade_proposals_proposer_idx on public.trade_proposals (proposer_id, created_at desc);

alter table public.trade_proposals enable row level security;

-- Either party can read a proposal; writes go through the SECURITY DEFINER RPCs
-- below, but we still scope direct access defensively.
drop policy if exists trade_proposals_select on public.trade_proposals;
create policy trade_proposals_select on public.trade_proposals
  for select using (auth.uid() = owner_id or auth.uid() = proposer_id);

grant select on public.trade_proposals to authenticated;

-- ── Notifications: allow a trade_proposal type ────────────────────────────────
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array['like','comment','follow','trade_proposal']));

-- ── Public read: the trade post for a username ────────────────────────────────
create or replace function public.get_trade_post(p_username text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '15s'
as $function$
declare
  v_uid        uuid;
  v_open       boolean;
  v_nick       text;
  v_accent     text;
  v_wants_json jsonb;
  v_want_ids   uuid[];
  v_binder     uuid;
  v_haves      jsonb;
  v_wants      jsonb;
begin
  select user_id, trade_open, nickname, profile_accent, trade_wants
    into v_uid, v_open, v_nick, v_accent, v_wants_json
  from user_settings
  where lower(nickname) = lower(p_username)
  limit 1;

  if v_uid is null then
    return null;
  end if;
  if not coalesce(v_open, false) then
    return jsonb_build_object('open', false, 'nickname', v_nick);
  end if;

  -- Featured want lists, validated to be this user's own list folders.
  select coalesce(array_agg(f.id), '{}')
    into v_want_ids
  from folders f
  where f.user_id = v_uid
    and f.type = 'list'
    and f.id::text in (select jsonb_array_elements_text(coalesce(v_wants_json, '[]'::jsonb)));

  select f.id into v_binder
  from folders f
  where f.user_id = v_uid
    and f.type = 'binder'
    and (public.safe_jsonb(f.description)->>'isTradeBinder') = 'true'
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name',             cp.name,
           'set_code',         cp.set_code,
           'collector_number', cp.collector_number,
           'image_uri',        cp.image_uri,
           'scryfall_id',      cp.scryfall_id,
           'foil',             c.foil,
           'qty',              fc.qty,
           'price', case when c.foil then coalesce(pr.price_foil_eur, pr.price_regular_eur)
                         else             coalesce(pr.price_regular_eur, pr.price_foil_eur) end
         ) order by cp.name), '[]'::jsonb)
    into v_haves
  from folder_cards fc
  join cards c        on c.id = fc.card_id
  join card_prints cp on cp.id = c.card_print_id
  left join card_prices pr
    on pr.scryfall_id = cp.scryfall_id and pr.snapshot_date = current_date
  where v_binder is not null and fc.folder_id = v_binder;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name',             li.name,
           'set_code',         li.set_code,
           'collector_number', li.collector_number,
           'scryfall_id',      li.scryfall_id,
           'foil',             li.foil,
           'qty',              li.qty
         ) order by li.name), '[]'::jsonb)
    into v_wants
  from list_items li
  where li.folder_id = any(v_want_ids);

  return jsonb_build_object(
    'open',     true,
    'nickname', v_nick,
    'accent',   coalesce(v_accent, ''),
    'haves',    coalesce(v_haves, '[]'::jsonb),
    'wants',    coalesce(v_wants, '[]'::jsonb)
  );
end;
$function$;

-- ── Submit a proposal (signed-in viewer) ─────────────────────────────────────
create or replace function public.propose_trade(
  p_owner_username text,
  p_requested jsonb,
  p_offered jsonb,
  p_note text
)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_owner    uuid;
  v_open     boolean;
  v_proposer uuid := auth.uid();
  v_id       uuid;
begin
  if v_proposer is null then
    raise exception 'Sign in to propose a trade.';
  end if;

  select user_id, trade_open into v_owner, v_open
  from user_settings
  where lower(nickname) = lower(p_owner_username)
  limit 1;

  if v_owner is null then
    raise exception 'Trader not found.';
  end if;
  if v_owner = v_proposer then
    raise exception 'You cannot propose a trade to yourself.';
  end if;
  if not coalesce(v_open, false) then
    raise exception 'This trader is not currently open to trades.';
  end if;
  if coalesce(jsonb_array_length(p_requested), 0) = 0
     and coalesce(jsonb_array_length(p_offered), 0) = 0 then
    raise exception 'Add at least one card to the proposal.';
  end if;

  insert into trade_proposals (owner_id, proposer_id, requested, offered, note)
  values (
    v_owner, v_proposer,
    coalesce(p_requested, '[]'::jsonb),
    coalesce(p_offered, '[]'::jsonb),
    nullif(btrim(coalesce(p_note, '')), '')
  )
  returning id into v_id;

  insert into notifications (user_id, actor_id, type)
  values (v_owner, v_proposer, 'trade_proposal');

  return v_id;
end;
$function$;

-- ── Owner inbox ──────────────────────────────────────────────────────────────
create or replace function public.get_trade_proposals()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v     jsonb;
begin
  if v_uid is null then
    return '[]'::jsonb;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',            tp.id,
           'proposer_name', us.nickname,
           'requested',     tp.requested,
           'offered',       tp.offered,
           'note',          tp.note,
           'status',        tp.status,
           'created_at',    tp.created_at
         ) order by tp.created_at desc), '[]'::jsonb)
    into v
  from trade_proposals tp
  left join user_settings us on us.user_id = tp.proposer_id
  where tp.owner_id = v_uid;
  return v;
end;
$function$;

-- ── Owner responds (accept / decline) ────────────────────────────────────────
create or replace function public.respond_to_trade_proposal(p_id uuid, p_status text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in to respond.';
  end if;
  if p_status not in ('accepted','declined') then
    raise exception 'Invalid status.';
  end if;
  update trade_proposals
    set status = p_status, updated_at = now()
  where id = p_id and owner_id = v_uid and status = 'pending';
  if not found then
    raise exception 'Proposal not found or already resolved.';
  end if;
end;
$function$;

-- ── Proposer cancels their own pending proposal ──────────────────────────────
create or replace function public.cancel_trade_proposal(p_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Sign in to cancel.';
  end if;
  update trade_proposals
    set status = 'cancelled', updated_at = now()
  where id = p_id and proposer_id = v_uid and status = 'pending';
  if not found then
    raise exception 'Proposal not found or already resolved.';
  end if;
end;
$function$;

grant execute on function public.get_trade_post(text)                 to anon, authenticated;
grant execute on function public.propose_trade(text, jsonb, jsonb, text) to authenticated;
grant execute on function public.get_trade_proposals()                to authenticated;
grant execute on function public.respond_to_trade_proposal(uuid, text) to authenticated;
grant execute on function public.cancel_trade_proposal(uuid)          to authenticated;

notify pgrst, 'reload schema';
