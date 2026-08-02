/**
 * Duplicating a builder deck.
 *
 * DeckBuilder already had this, but only over the deck it currently has loaded
 * in memory. The Builder index needs to copy a deck it has never opened, so the
 * card/category fetch lives here. The two naming + meta rules are shared so the
 * copy behaves the same wherever it was started from.
 *
 * Collection decks are deliberately not duplicable: their contents are
 * `deck_allocations` pointing at specific owned `cards` rows, and copying those
 * would either double-count owned inventory or invent an ownership claim. Copy
 * the builder side instead.
 */

import { sb } from './supabase'
import { toDeckCardRow } from './deckBuilderWrites'
import { parseDeckMeta, serializeDeckMeta } from './deckBuilderApi'

/**
 * Strip everything that identifies the *original* deck from a copied meta blob.
 * A copy is a private, unlinked, unhidden deck — carrying the pair links over
 * would leave two builder decks claiming the same collection counterpart.
 */
export function makeDeckCopyMeta(meta) {
  const next = { ...(meta || {}) }
  next.is_public = false
  delete next.linked_deck_id
  delete next.linked_builder_id
  delete next.sync_state
  delete next.last_sync_at
  delete next.last_sync_snapshot
  delete next.unsynced_builder
  delete next.unsynced_collection
  delete next.hideFromBuilder
  return next
}

/**
 * First free "<name> copy N". `folders` is unique on (user_id, name, type) and
 * both deck types share the namespace, so the check spans both.
 */
export async function getNextCopyDeckName(userId, baseName) {
  const base = String(baseName || 'Deck').trim() || 'Deck'
  const { data } = await sb.from('folders')
    .select('name')
    .eq('user_id', userId)
    .in('type', ['builder_deck', 'deck'])
  const taken = new Set((data || []).map(row => String(row.name || '').toLowerCase()))
  let n = 1
  while (taken.has(`${base} copy ${n}`.toLowerCase())) n += 1
  return `${base} copy ${n}`
}

/**
 * Copy a builder deck (folder row + categories + cards) into a new deck owned
 * by the same user. Rolls the new folder back if the card/category inserts
 * fail, so a half-copied deck never shows up in the index.
 *
 * @returns the inserted `folders` row
 */
export async function duplicateBuilderDeck({ userId, deck }) {
  if (!userId || !deck?.id) throw new Error('duplicateBuilderDeck needs a user and a deck')
  if (deck.type !== 'builder_deck') throw new Error('Only builder decks can be duplicated')

  const now = new Date().toISOString()
  const copyName = await getNextCopyDeckName(userId, deck.name)
  const copyMeta = makeDeckCopyMeta(deck.__meta || parseDeckMeta(deck.description))

  const { data: newDeck, error: deckError } = await sb.from('folders').insert({
    user_id: userId,
    type: 'builder_deck',
    name: copyName,
    description: serializeDeckMeta(copyMeta),
  }).select().single()
  if (deckError) throw deckError

  try {
    const [{ data: categories, error: catReadErr }, { data: cards, error: cardReadErr }] = await Promise.all([
      sb.from('deck_categories').select('id, name, sort_order').eq('deck_id', deck.id).order('sort_order'),
      sb.from('deck_cards').select('*').eq('deck_id', deck.id).range(0, 4999),
    ])
    if (catReadErr)  throw catReadErr
    if (cardReadErr) throw cardReadErr

    // Categories are cloned first so the cards can be re-pointed at the new ids.
    const categoryIdMap = new Map()
    if (categories?.length) {
      const categoryInserts = categories.map(cat => ({
        id: crypto.randomUUID(),
        deck_id: newDeck.id,
        user_id: userId,
        name: cat.name,
        sort_order: cat.sort_order ?? 0,
        created_at: now,
      }))
      const { error: catError } = await sb.from('deck_categories').insert(categoryInserts)
      if (catError) throw catError
      categories.forEach((cat, i) => categoryIdMap.set(cat.id, categoryInserts[i].id))
    }

    if (cards?.length) {
      const rows = cards.map(card => toDeckCardRow({
        ...card,
        id: crypto.randomUUID(),
        deck_id: newDeck.id,
        user_id: userId,
        category_id: card.category_id ? (categoryIdMap.get(card.category_id) || null) : null,
        created_at: now,
        updated_at: now,
      }))
      const { error: cardsError } = await sb.from('deck_cards').insert(rows)
      if (cardsError) throw cardsError
    }
  } catch (err) {
    // Best-effort rollback — an empty orphan deck is worse than no deck.
    await sb.from('deck_cards').delete().eq('deck_id', newDeck.id)
    await sb.from('deck_categories').delete().eq('deck_id', newDeck.id)
    await sb.from('folders').delete().eq('id', newDeck.id).eq('user_id', userId)
    throw err
  }

  return newDeck
}
