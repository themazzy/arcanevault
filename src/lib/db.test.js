// fake-indexeddb/auto must be imported before db.js so idb's openDB sees the
// polyfilled globals.
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { getMeta, setMeta, getDeckCards, putDeckCards, replaceDeckCards, deleteDeckCardsLocal, _simulateExternalConnectionClose } from './db'

describe('IDB connection recovery', () => {
  it('reads and writes through the meta store', async () => {
    await setMeta('probe-key', 'probe-value')
    expect(await getMeta('probe-key')).toBe('probe-value')
  })

  // Browsers close IDB connections behind backgrounded tabs (Android under
  // memory pressure especially). The cached handle then throws "Failed to
  // execute 'transaction' on 'IDBDatabase': The database connection is
  // closing" on every call until reload — seen live in the Build Assistant.
  // The db layer must detect the dead handle and reopen transparently.
  it('recovers after the browser closes the connection externally', async () => {
    await setMeta('survives-close', 'yes')

    await _simulateExternalConnectionClose()

    expect(await getMeta('survives-close')).toBe('yes')
    // Writes must recover too, not just reads.
    await setMeta('post-close-write', 'ok')
    expect(await getMeta('post-close-write')).toBe('ok')
  })

  it('recovers repeatedly, not just once', async () => {
    for (let i = 0; i < 3; i++) {
      await _simulateExternalConnectionClose()
      await setMeta(`round-${i}`, i)
      expect(await getMeta(`round-${i}`)).toBe(i)
    }
  })
})

describe('deleteDeckCardsLocal', () => {
  // Bulk sibling of deleteDeckCardLocal — Build Assistant "Cut all" removes
  // the whole batch in one transaction instead of one delete per card.
  it('deletes only the given ids in one call', async () => {
    const deckId = 'deck-bulk-delete'
    await putDeckCards([
      { id: 'dc-1', deck_id: deckId, name: 'Cut me' },
      { id: 'dc-2', deck_id: deckId, name: 'Cut me too' },
      { id: 'dc-3', deck_id: deckId, name: 'Keep me' },
    ])

    await deleteDeckCardsLocal(['dc-1', 'dc-2'])

    const remaining = await getDeckCards(deckId)
    expect(remaining.map(r => r.id)).toEqual(['dc-3'])
  })

  it('is a no-op for an empty or missing id list', async () => {
    const deckId = 'deck-bulk-noop'
    await putDeckCards([{ id: 'dc-keep', deck_id: deckId, name: 'Stays' }])
    await deleteDeckCardsLocal([])
    await deleteDeckCardsLocal(undefined)
    expect((await getDeckCards(deckId)).map(r => r.id)).toEqual(['dc-keep'])
  })
})

describe('replaceDeckCards', () => {
  // DeckBuilder seeds its first paint from this store, so a row the server no
  // longer returns has to leave it. putDeckCards merges, which meant a card
  // deleted on another device stayed cached and reappeared as a ghost on every
  // subsequent open — local deletes prune, cross-device ones never did.
  it('drops cached rows the authoritative fetch no longer returns', async () => {
    const deckId = 'deck-reconcile'
    await putDeckCards([
      { id: 'dc-a', deck_id: deckId, name: 'Still there' },
      { id: 'dc-gone', deck_id: deckId, name: 'Deleted on another device' },
    ])

    await replaceDeckCards(deckId, [
      { id: 'dc-a', deck_id: deckId, name: 'Still there' },
      { id: 'dc-new', deck_id: deckId, name: 'Added on another device' },
    ])

    const rows = await getDeckCards(deckId)
    expect(rows.map(r => r.id).sort()).toEqual(['dc-a', 'dc-new'])
  })

  it('leaves other decks alone', async () => {
    const other = 'deck-reconcile-other'
    await putDeckCards([{ id: 'dc-other', deck_id: other, name: 'Untouched' }])
    await replaceDeckCards('deck-reconcile-empty', [])
    expect((await getDeckCards(other)).map(r => r.id)).toEqual(['dc-other'])
  })

  // An emptied deck must clear, not silently keep its last known contents.
  it('clears a deck whose fetch came back empty', async () => {
    const deckId = 'deck-reconcile-cleared'
    await putDeckCards([{ id: 'dc-x', deck_id: deckId, name: 'Removed' }])
    await replaceDeckCards(deckId, [])
    expect(await getDeckCards(deckId)).toEqual([])
  })
})
