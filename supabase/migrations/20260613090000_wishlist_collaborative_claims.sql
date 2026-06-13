-- Collaborative wishlist claims: people with a shared wishlist link can mark
-- items as "I'll get this" so gift-givers don't double-buy.
--
-- Access model: Share.jsx requires sign-in, so claimers are authenticated
-- users (no anon writes). list_items stays owner-only RLS; all shared access
-- goes through these two SECURITY DEFINER RPCs, each gated by the share token
-- resolving to the item's folder. The list owner is deliberately shown NO
-- claim info (preserves the gift surprise) and cannot claim their own list.

alter table public.list_items
  add column if not exists claimed_by uuid references auth.users(id) on delete set null,
  add column if not exists claimed_at timestamptz;

-- Read: items of the wishlist shared under p_token, with per-caller claim
-- flags. Returns nothing if the token is unknown or the folder is not a list.
create or replace function public.get_shared_wishlist(p_token text)
returns table (
  id uuid,
  card_print_id uuid,
  scryfall_id text,
  name text,
  set_code text,
  collector_number text,
  foil boolean,
  qty integer,
  type_line text,
  mana_cost text,
  cmc numeric,
  color_identity text[],
  image_uri text,
  art_crop_uri text,
  is_claimed boolean,
  claimed_by_me boolean
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_folder_id uuid;
  v_owner_id  uuid;
  v_caller    uuid := auth.uid();
begin
  select sf.folder_id, f.user_id
    into v_folder_id, v_owner_id
  from public.shared_folders sf
  join public.folders f on f.id = sf.folder_id
  where sf.public_token = p_token and f.type = 'list';

  if v_folder_id is null then
    return; -- unknown token or not a wishlist
  end if;

  return query
  select
    v.id, v.card_print_id, v.scryfall_id, v.name, v.set_code, v.collector_number,
    v.foil, v.qty, v.type_line, v.mana_cost, v.cmc, v.color_identity,
    v.image_uri, v.art_crop_uri,
    -- The owner never sees claim state (don't spoil the surprise).
    case when v_caller = v_owner_id then false else (li.claimed_by is not null) end as is_claimed,
    case when v_caller = v_owner_id then false else (li.claimed_by = v_caller) end as claimed_by_me
  from public.list_items_view v
  join public.list_items li on li.id = v.id
  where v.folder_id = v_folder_id
  order by v.name;
end;
$function$;

-- Write: toggle the caller's claim on one item of a shared wishlist.
-- Returns the new (is_claimed, claimed_by_me) for that item.
create or replace function public.toggle_wishlist_claim(p_token text, p_item_id uuid, p_claimed boolean)
returns table (is_claimed boolean, claimed_by_me boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_folder_id uuid;
  v_owner_id  uuid;
  v_caller    uuid := auth.uid();
  v_current   uuid;
begin
  if v_caller is null then
    raise exception 'Sign in to claim wishlist items.';
  end if;

  select sf.folder_id, f.user_id
    into v_folder_id, v_owner_id
  from public.shared_folders sf
  join public.folders f on f.id = sf.folder_id
  where sf.public_token = p_token and f.type = 'list';

  if v_folder_id is null then
    raise exception 'This wishlist link is invalid.';
  end if;
  if v_caller = v_owner_id then
    raise exception 'You cannot claim items on your own wishlist.';
  end if;

  -- The item must belong to the shared folder.
  select claimed_by into v_current
  from public.list_items
  where id = p_item_id and folder_id = v_folder_id;
  if not found then
    raise exception 'That item is not part of this wishlist.';
  end if;

  if p_claimed then
    -- Claim only if free, or already mine (idempotent). Never steal a claim.
    if v_current is not null and v_current <> v_caller then
      return query select true, false;
      return;
    end if;
    update public.list_items
      set claimed_by = v_caller, claimed_at = now()
      where id = p_item_id;
    return query select true, true;
  else
    -- Unclaim only my own.
    if v_current = v_caller then
      update public.list_items
        set claimed_by = null, claimed_at = null
        where id = p_item_id;
    end if;
    return query select false, false;
  end if;
end;
$function$;

-- Public-schema GRANTs must be explicit. Authenticated only (Share.jsx
-- requires sign-in); the owner-guard lives inside the functions.
revoke execute on function public.get_shared_wishlist(text) from public, anon;
revoke execute on function public.toggle_wishlist_claim(text, uuid, boolean) from public, anon;
grant execute on function public.get_shared_wishlist(text) to authenticated;
grant execute on function public.toggle_wishlist_claim(text, uuid, boolean) to authenticated;
