import { sb } from './supabase'
import { parseDeckMeta } from './deckBuilderApi'

// Loads everything the public deck view needs to render.
//
// The folder row and the card list used to be fetched one after the other, so
// /d/:id — the page every shared link lands on — paid two serial round trips
// before it could show anything. They do not depend on each other:
// get_deck_cards_for_view gates on the deck being public server-side, so racing
// them cannot leak a private list. The worst case is one wasted RPC for a deck
// we then refuse to render.
//
// Promise.all rather than two bare assignments on purpose: a PostgREST builder
// is lazy and does not issue its request until something calls then() on it, so
// assigning one to a variable would still be serial.
export async function fetchDeckForView({ client = sb, id, viewerId = null } = {}) {
  const [folderRes, cardsRes] = await Promise.all([
    client.from('folders').select('*').eq('id', id).maybeSingle(),
    client.rpc('get_deck_cards_for_view', { p_deck_id: id }),
  ])

  const folder = folderRes?.data
  if (folderRes?.error || !folder) return { error: 'Deck not found' }

  const meta = parseDeckMeta(folder.description)
  // A private deck is reported as missing rather than forbidden — the owner's
  // deck list is not something a stranger should be able to probe.
  if (!meta.is_public && folder.user_id !== viewerId) return { error: 'Deck not found' }

  const rpcCards = cardsRes?.data
  return {
    deck: folder,
    meta,
    cards: Array.isArray(rpcCards) ? rpcCards : (rpcCards || []),
  }
}
