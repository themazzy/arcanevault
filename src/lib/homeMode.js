import { sb } from './supabase'
import { getLocalCards, getLocalFolders } from './db'
import { fetchOwnedCardCount } from './collectionFetchers'
import { parseDeckMeta } from './deckBuilderApi'
import { perfSpan } from './perf'

// Everything Home needs to decide WHICH layout to render, and nothing else.
//
// getHomeMode (homeLayout.js) only asks a boolean question — "does this account
// have anything in it?" — so making it wait on the full collection load kept the
// whole page dark for the length of a cold card walk plus Scryfall enrichment.
// This resolves in one parallel round trip; the collection snapshot behind
// CollectionPulse loads separately and skeletons its own tiles until it lands.
//
// Keep this free of anything that walks the collection.
export async function loadHomeMode(userId) {
  const endMode = perfSpan('home-mode-load')
  const [myDecksResult, cardCount, idbFolders] = await Promise.all([
    sb.rpc('get_my_decks'),
    countOwnedCards(userId),
    getLocalFolders(userId),
  ])

  const deckSource = !myDecksResult.error && Array.isArray(myDecksResult.data)
    ? myDecksResult.data
    : (idbFolders || [])

  endMode()
  return { builderDecks: selectBuilderDecks(deckSource), cardCount }
}

// Builder decks shown by Continue Building: standalone builder decks only —
// group containers, hidden decks, and the builder half of a linked pair are all
// represented elsewhere.
export function selectBuilderDecks(rows) {
  return (rows || [])
    .filter(deck => {
      if (deck.type !== 'builder_deck') return false
      const meta = parseDeckMeta(deck.description)
      return !meta.isGroup && !meta.hideFromBuilder && !meta.linked_deck_id
    })
    .sort((a, b) => deckSortTime(b) - deckSortTime(a))
}

function deckSortTime(deck) {
  return Date.parse(deck.deck_modified_at || deck.updated_at || deck.created_at || 0) || 0
}

// A failed count must never push someone who owns cards into the onboarding
// layout, so fall back to whatever IDB last cached rather than to zero.
async function countOwnedCards(userId) {
  try {
    return await fetchOwnedCardCount(userId)
  } catch {
    const local = await getLocalCards(userId)
    return local?.length || 0
  }
}
