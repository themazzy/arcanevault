// Set-completion helpers for the Stats page "Collector mode" view: which
// cards from a set are missing, what completing it would cost, and adding
// the gaps to a wishlist.

import { sfGet } from './scryfall'
import { getPrice } from './scryfall'
import { sb } from './supabase'
import { requireCardPrintIds, toListItemRow } from './deckBuilderWrites'

const SF = 'https://api.scryfall.com'

// Full set lists are fetched on demand when a user expands a set and kept
// in memory for the session only (a large set is ~400 cards ≈ a few MB of
// JSON we don't want in IDB).
const setCardsCache = new Map()

export async function fetchSetCards(setCode) {
  const code = String(setCode || '').toLowerCase()
  if (!code) return []
  if (setCardsCache.has(code)) return setCardsCache.get(code)

  const cards = []
  let url = `${SF}/cards/search?q=${encodeURIComponent(`e:${code}`)}&unique=prints&order=set`
  while (url) {
    const data = await sfGet(url)
    for (const card of data?.data || []) cards.push(card)
    url = data?.has_more ? data.next_page : null
  }
  setCardsCache.set(code, cards)
  return cards
}

// Collector numbers sort like "1" < "2" < "10" < "10a" < "C1".
export function collectorNumberCompare(a, b) {
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  const aNum = Number.isNaN(na) ? Infinity : na
  const bNum = Number.isNaN(nb) ? Infinity : nb
  if (aNum !== bNum) return aNum - bNum
  return String(a).localeCompare(String(b))
}

/**
 * @param {Array} setCards      Full Scryfall card list for the set
 * @param {Set}   ownedNumbers  Collector numbers (strings) the user owns
 */
export function computeMissingCards(setCards, ownedNumbers) {
  return (setCards || [])
    .filter(card => !ownedNumbers.has(String(card.collector_number)))
    .sort((a, b) => collectorNumberCompare(a.collector_number, b.collector_number))
}

/** Sum of nonfoil prices for the missing cards; counts how many had a price. */
export function missingCostTotal(missingCards, price_source) {
  let total = 0
  let priced = 0
  for (const card of missingCards || []) {
    const price = getPrice(card, false, { price_source })
    if (price != null) {
      total += price
      priced += 1
    }
  }
  return { total, priced }
}

/** Insert missing cards into a wishlist (list folder). Skips none — the
 *  upsert's (folder_id, card_print_id, foil) conflict makes re-adds no-ops. */
export async function addMissingToWishlist({ folderId, userId, sfCards }) {
  if (!folderId || !sfCards?.length) return 0
  const baseRows = sfCards.map(card => ({
    folder_id: folderId,
    user_id: userId,
    qty: 1,
    foil: false,
    name: card.name,
    scryfall_id: card.id,
    set_code: card.set,
    collector_number: card.collector_number,
    type_line: card.type_line,
    mana_cost: card.mana_cost,
    cmc: card.cmc,
    color_identity: card.color_identity,
    image_uri: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null,
    art_crop_uri: card.image_uris?.art_crop || card.card_faces?.[0]?.image_uris?.art_crop || null,
  }))
  const hydrated = await requireCardPrintIds(baseRows, 'Wishlist item')
  const { error } = await sb
    .from('list_items')
    .upsert(hydrated.map(toListItemRow), { onConflict: 'folder_id,card_print_id,foil', ignoreDuplicates: true })
  if (error) throw error
  return hydrated.length
}
