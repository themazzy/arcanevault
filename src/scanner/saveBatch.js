/**
 * Pure planning for the scanner basket's "save all" write path.
 *
 * CardScanner keeps the I/O (which queries run, in what order); everything that
 * decides *what* to write lives here so it can be tested without a Supabase
 * client. The shapes involved:
 *
 *   pending card  — basket entry: { id (scryfall), name, setCode, collNum,
 *                   foil, qty, condition ('NM'…), language }
 *   owned row     — a `cards` row payload, already carrying card_print_id
 *   saved row     — what the cards upsert returned: { id, card_print_id, foil,
 *                   language, condition, qty }
 */

import { omitId } from '../lib/deckBuilderWrites'

export const CONDITION_DB = {
  NM: 'near_mint',
  LP: 'lightly_played',
  MP: 'moderately_played',
  HP: 'heavily_played',
  DMG: 'damaged',
}

// Identity of an owned copy — the columns in cards_unique_owned_print_idx.
// card_print_id is NOT NULL on `cards`, so the set/collector fallback only ever
// applies to a basket entry whose printing has not been resolved yet; such a row
// can never match a stored one, which is exactly what we want (it must be caught
// before the write, not silently merged into someone else's row).
export function ownedCardKey(row) {
  const printPart = row?.card_print_id
    ? `print:${row.card_print_id}`
    : `set:${row?.set_code}|${row?.collector_number}`
  return [printPart, row?.foil ? 1 : 0, row?.language || 'en', row?.condition || 'near_mint'].join('|')
}

// Copies, not distinct entries: the basket collapses repeat scans of the same
// print+finish+condition into one row with a qty, so `cards.length` undercounts
// what the user actually scanned.
export function totalPendingQty(cards) {
  return (cards || []).reduce((sum, card) => sum + (card.qty || 1), 0)
}

// Basket entries → deduplicated `cards` payloads, summing quantities.
export function aggregateOwnedRows(cards, userId) {
  const byKey = new Map()
  for (const c of cards || []) {
    const row = {
      user_id: userId,
      name: c.name,
      set_code: c.setCode,
      collector_number: c.collNum,
      scryfall_id: c.id,
      foil: !!c.foil,
      qty: c.qty ?? 1,
      condition: CONDITION_DB[c.condition] || 'near_mint',
      language: c.language || 'en',
      currency: 'EUR',
    }
    const key = ownedCardKey(row)
    const prev = byKey.get(key)
    if (prev) {
      prev.qty += row.qty
      prev.name = row.name
      prev.scryfall_id = row.scryfall_id
    } else {
      byKey.set(key, row)
    }
  }
  return [...byKey.values()]
}

// Basket entries → deduplicated `list_items` payloads. Wishlist identity is
// print + finish only; condition and language are ownership facts and a wanted
// card is not owned yet.
export function aggregateListItems(cards, { folderId, userId }) {
  const byKey = new Map()
  for (const c of cards || []) {
    const key = [c.setCode, c.collNum, c.foil ? 1 : 0].join('|')
    const prev = byKey.get(key)
    if (prev) {
      prev.qty += c.qty ?? 1
    } else {
      byKey.set(key, {
        folder_id: folderId,
        user_id: userId,
        name: c.name,
        set_code: c.setCode,
        collector_number: c.collNum,
        scryfall_id: c.id,
        foil: !!c.foil,
        qty: c.qty ?? 1,
      })
    }
  }
  return [...byKey.values()]
}

/**
 * Merge the rows being saved against the rows the user already owns.
 *
 * Emits a single upsert batch rather than an UPDATE per existing row: a 29-card
 * scan session meant 29 sequential round trips, which dominated the save. No row
 * may carry an `id` — see omitId in deckBuilderWrites for why that corrupts a
 * PostgREST upsert.
 */
export function planOwnedCardWrites({ owned, existing }) {
  const existByKey = new Map((existing || []).map(row => [ownedCardKey(row), row]))
  const existingIds = new Set((existing || []).map(row => row.id).filter(Boolean))
  const upsertRows = (owned || []).map(row => {
    const prev = existByKey.get(ownedCardKey(row))
    return omitId(prev ? { ...prev, ...row, qty: (prev.qty || 0) + (row.qty || 0) } : row)
  })
  return { upsertRows, existingIds }
}

// Which of the upserted rows did not exist before. Only these may be pruned if
// the placement write fails — an existing row must survive, it holds copies the
// user already had.
export function newlyInsertedIds(savedRows, existingIds) {
  return (savedRows || [])
    .map(row => row.id)
    .filter(id => id && !existingIds?.has(id))
}

/**
 * Placement rows for the destination folder, adding the scanned copies to
 * whatever the folder already holds.
 *
 * `complete` is false when a saved row could not be matched back to an input
 * row; the caller must treat that as a failed save rather than writing a partial
 * placement set, because an owned card with no placement is invisible in the UI
 * (see collectionOwnership.js).
 */
export function planPlacementLinks({ owned, savedRows, existingLinkQty, destinationType, folderId, userId }) {
  const savedByKey = new Map((savedRows || []).map(row => [ownedCardKey(row), row]))
  const links = []
  for (const row of owned || []) {
    const saved = savedByKey.get(ownedCardKey(row))
    if (!saved) continue
    const base = {
      card_id: saved.id,
      qty: (existingLinkQty?.get(saved.id) || 0) + (row.qty ?? 1),
    }
    links.push(destinationType === 'deck'
      ? { ...base, deck_id: folderId, user_id: userId }
      : { ...base, folder_id: folderId })
  }
  return { links, complete: links.length === (owned || []).length }
}
