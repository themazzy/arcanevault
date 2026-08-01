-- Digital-only printings (Magic Online, Arena, Alchemy) sit in card_prints and
-- carry no market price, so the cheapest-first rule can never choose one — but
-- the "no printing is priced" fallback orders by released_at and happily hands
-- back an MTGO promo that does not exist in paper. Crusade is the clearest
-- case: 13 paper printings, and the newest English row is the Magic Online one.
--
-- scripts/lib/print-sync-core.mjs has rejected `card.digital` for a while, so
-- the daily bulk sync no longer adds these; the ~9k rows below are legacy, plus
-- whatever the on-demand app-side writer (buildCardPrintPayload) inserted.
-- Storing the flag lets both the RPCs and the client filter on it directly
-- instead of inferring "digital" from a missing price.

alter table public.card_prints
  add column if not exists digital boolean not null default false;

-- Backfill from Scryfall's own set list (`GET /sets` where digital = true),
-- captured 2026-08-01. Set-scoped rather than per-card because every printing
-- in a digital set is digital.
update public.card_prints
set digital = true
where digital = false
  and set_code in (
    'ysos','yecl','aa4','aa3','omb','om1','aa2','aa1','yeoe','pa1','ytdm','ydft',
    'pio','ydsk','yblb','yotj','ymkm','ylci','ywoe','ea3','ha7','sis','sir','yone',
    'ybro','ea2','ydmu','ha6','ea1','hbg','ysnc','yneo','ymid','j21','ha5','ha4',
    'klr','akr','anb','ajmp','ha3','ha2','ha1','xana','ana','pana','oana','pz2',
    'pz1','tpr','vma','td2','me4','td0','me3','me2','me1','pmoa','prm','psdg','past'
  );

comment on column public.card_prints.digital is
  'True for Magic Online / Arena / Alchemy printings with no paper existence. Written from Scryfall''s card.digital by the sync scripts; excluded from every deck-building printing choice.';
