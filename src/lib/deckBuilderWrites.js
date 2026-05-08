/**
 * Deck-builder write helpers extracted from DeckBuilder.jsx.
 *
 * These all live outside React state — pure functions over Supabase calls. They
 * intentionally throw on error so callers can wrap with try/catch + toast.
 *
 * Test seam: pass `sb` as a parameter to ease unit testing — currently we still
 * import the live client to keep the diff small.
 */

import { sb } from './supabase'
import { ensureCardPrints, getCardPrint, withCardPrint } from './cardPrints'

// Phase 5d: denormalized print columns (scryfall_id/name/set_code/
// collector_number/type_line/mana_cost/cmc/color_identity/image_uri) are no
// longer written to deck_cards/cards/list_items — they're sourced from
// card_prints via the *_view joins. Keep these helpers narrow so any payload
// fed through them is automatically schema-correct.
export const DECK_CARD_DB_COLS = new Set([
  'id', 'deck_id', 'user_id', 'qty', 'foil', 'is_commander', 'board',
  'created_at', 'updated_at', 'card_print_id', 'category_id',
])

export function toDeckCardRow(row) {
  const out = {}
  for (const k of DECK_CARD_DB_COLS) if (k in row) out[k] = row[k]
  return out
}

export const OWNED_CARD_DB_COLS = new Set([
  'id', 'user_id', 'card_print_id', 'qty', 'foil', 'condition', 'language',
  'purchase_price', 'currency', 'misprint', 'altered', 'added_at', 'updated_at',
])

export function toOwnedCardRow(row) {
  const out = {}
  for (const k of OWNED_CARD_DB_COLS) if (k in row) out[k] = row[k]
  return out
}

export const LIST_ITEM_DB_COLS = new Set([
  'id', 'folder_id', 'user_id', 'card_print_id', 'qty', 'foil', 'added_at',
])

export function toListItemRow(row) {
  const out = {}
  for (const k of LIST_ITEM_DB_COLS) if (k in row) out[k] = row[k]
  return out
}

export function toCardPrintSource(row) {
  return {
    scryfall_id: row?.scryfall_id || null,
    name: row?.name || null,
    set_code: row?.set_code || row?.set || null,
    collector_number: row?.collector_number || row?.collNum || null,
    type_line: row?.type_line || null,
    mana_cost: row?.mana_cost || null,
    cmc: row?.cmc ?? null,
    color_identity: row?.color_identity || [],
    image_uri: row?.image_uri || null,
    art_crop_uri: row?.art_crop_uri || null,
  }
}

export async function requireCardPrintIds(rows, context = 'Card') {
  const needsPrint = (rows || []).filter(row => !row.card_print_id)
  if (!needsPrint.length) return rows || []

  const printMap = await ensureCardPrints(needsPrint.map(toCardPrintSource))
  const hydrated = (rows || []).map(row => {
    if (row.card_print_id) return row
    return withCardPrint(row, getCardPrint(printMap, toCardPrintSource(row)))
  })
  const missing = hydrated.find(row => !row.card_print_id)
  if (missing) throw new Error(`${context} could not resolve a card print for ${missing.name || 'unknown card'}.`)
  return hydrated
}

export function ownedCardKey(row) {
  return [
    row.card_print_id,
    row.foil ? '1' : '0',
    row.language || 'en',
    row.condition || 'near_mint',
  ].join('|')
}

export async function additiveSaveOwnedCards(rows, context = 'Owned card') {
  // Validate user_id invariant BEFORE merging — otherwise rows with different
  // user_ids that share an ownedCardKey would silently collapse and bypass the
  // assertion.
  const inputUserIds = new Set((rows || []).map(row => row.user_id).filter(Boolean))
  if ((rows || []).length && inputUserIds.size === 0) {
    throw new Error('additiveSaveOwnedCards: rows missing user_id')
  }
  if (inputUserIds.size > 1) {
    throw new Error(`additiveSaveOwnedCards: rows mix multiple user_ids (${[...inputUserIds].join(', ')}); refusing to write`)
  }

  const hydratedRows = await requireCardPrintIds(rows, context)
  const merged = new Map()
  for (const row of hydratedRows) {
    const key = ownedCardKey(row)
    const existing = merged.get(key)
    merged.set(key, existing ? { ...existing, qty: (existing.qty || 0) + (row.qty || 0) } : row)
  }

  const incomingRows = [...merged.values()]
  if (!incomingRows.length) return []
  const printIds = [...new Set(incomingRows.map(row => row.card_print_id))]
  let existingRows = []
  if (printIds.length) {
    const { data, error } = await sb.from('cards')
      .select('id,user_id,foil,qty,condition,language,purchase_price,currency,card_print_id,added_at')
      .eq('user_id', incomingRows[0].user_id)
      .in('card_print_id', printIds)
    if (error) throw error
    existingRows = data || []
  }

  const existingByKey = new Map(existingRows.map(row => [ownedCardKey(row), row]))
  const rowsToSave = incomingRows.map(row => {
    const existing = existingByKey.get(ownedCardKey(row))
    return existing
      ? {
          ...existing,
          ...row,
          id: existing.id,
          qty: (existing.qty || 0) + (row.qty || 0),
          purchase_price: existing.purchase_price ?? row.purchase_price ?? 0,
          currency: existing.currency || row.currency || 'EUR',
        }
      : row
  })

  // Strip denormalized cols at the upsert boundary (post-5d the schema no
  // longer carries them).
  const { data, error } = await sb.from('cards')
    .upsert(rowsToSave.map(toOwnedCardRow), { onConflict: 'user_id,card_print_id,foil,language,condition' })
    .select('id,user_id,foil,qty,condition,language,purchase_price,currency,card_print_id,added_at')
  if (error) throw error
  // Re-attach the denorm metadata each input row carried, so downstream
  // consumers (IDB hydration, UI updates) keep their existing shape.
  const inputByKey = new Map(rowsToSave.map(row => [ownedCardKey(row), row]))
  return (data || []).map(row => {
    const input = inputByKey.get(ownedCardKey(row))
    return input ? { ...input, ...row } : row
  })
}

export async function additiveSaveWishlistItems(folderId, userId, rows, context = 'Wishlist item') {
  const hydratedRows = await requireCardPrintIds(
    (rows || []).map(row => ({ ...row, folder_id: folderId, user_id: userId })),
    context
  )
  const merged = new Map()
  for (const row of hydratedRows) {
    const key = `${row.card_print_id}|${row.foil ? '1' : '0'}`
    const existing = merged.get(key)
    merged.set(key, existing ? { ...existing, qty: (existing.qty || 0) + (row.qty || 0) } : row)
  }

  const incomingRows = [...merged.values()]
  if (!incomingRows.length) return []
  const printIds = [...new Set(incomingRows.map(row => row.card_print_id))]
  let existingRows = []
  if (printIds.length) {
    const { data, error } = await sb.from('list_items')
      .select('card_print_id,foil,qty')
      .eq('folder_id', folderId)
      .in('card_print_id', printIds)
    if (error) throw error
    existingRows = data || []
  }

  const existingQtyByKey = new Map(existingRows.map(row => [`${row.card_print_id}|${row.foil ? '1' : '0'}`, row.qty || 0]))
  const rowsToSave = incomingRows.map(row => ({
    ...row,
    folder_id: row.folder_id,
    user_id: row.user_id,
    card_print_id: row.card_print_id,
    foil: row.foil ?? false,
    qty: (row.qty || 0) + (existingQtyByKey.get(`${row.card_print_id}|${row.foil ? '1' : '0'}`) || 0),
  }))

  // Strip denormalized cols at the upsert boundary; re-attach metadata from
  // the input rows so callers keep the existing shape.
  const { data, error } = await sb.from('list_items')
    .upsert(rowsToSave.map(toListItemRow), { onConflict: 'folder_id,card_print_id,foil' })
    .select('id,folder_id,user_id,card_print_id,foil,qty,added_at')
  if (error) throw error
  const inputByKey = new Map(rowsToSave.map(row => [`${row.card_print_id}|${row.foil ? '1' : '0'}`, row]))
  return (data || []).map(row => {
    const input = inputByKey.get(`${row.card_print_id}|${row.foil ? '1' : '0'}`)
    return input ? { ...input, ...row } : row
  })
}
