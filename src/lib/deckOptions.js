// Deck choices for the life tracker's "which deck are you playing?" pickers.
//
// A folder row is not the same thing as a deck. Two cases have to be handled or
// the list misrepresents what the user owns:
//
//   1. Linked pairs. A builder deck and a collection deck can be linked as one
//      physical deck (linked_deck_id / linked_builder_id in the folder's
//      description blob). Both rows have the same name, so the deck appeared
//      twice. Of DeckLoom's 124 deck folders, 13 are linked pairs.
//
//   2. Group folders. A folder whose description carries isGroup: true is an
//      organisational container, not a deck, and must never be selectable.
//
// For a linked pair the BUILDER half wins, because that is the id win rates are
// read by: /builder/:id queries game_results.deck_id against the builder deck's
// folder id (DeckBuilder.jsx loadDeckGameResults). Attributing a game to the
// collection half would record it correctly in Stats but leave the deck builder's
// win rate showing nothing.
//
// Deliberately dependency-free: the equivalent helpers live in collectionFetchers
// (isGroupFolder) and deckSync (getLinkedDeckIds), but those modules pull in
// supabase, IndexedDB and price loading, and this one is used on the public
// /join/:code route. The description blob is parsed once here instead of three
// times across three modules. Field names are kept identical so the meaning
// cannot drift.

export const DECK_TYPE_LABEL = {
  builder_deck: 'Builder',
  deck: 'Collection',
}

function readMeta(folder) {
  try { return JSON.parse(folder?.description || '{}') } catch { return {} }
}

/**
 * @param {Array<{id:string,name:string,type:string,description?:string}>} folders
 * @returns {Array<{id:string,name:string,type:string,label:string}>}
 */
export function buildDeckOptions(folders) {
  const rows = (folders || []).filter(f => f?.id && (f.type === 'deck' || f.type === 'builder_deck'))

  const meta = new Map(rows.map(f => [f.id, readMeta(f)]))
  const present = new Set(rows.map(f => f.id))

  // Collection decks that a *present* builder deck claims as its other half. The
  // "present" check matters: if only the collection half was loaded, dropping it
  // would lose the deck from the list entirely.
  const supersededByBuilder = new Set()
  for (const folder of rows) {
    if (folder.type !== 'builder_deck') continue
    const linkedDeckId = meta.get(folder.id)?.linked_deck_id
    if (linkedDeckId && present.has(linkedDeckId)) supersededByBuilder.add(linkedDeckId)
  }

  const kept = rows.filter(folder => {
    if (meta.get(folder.id)?.isGroup === true) return false
    if (folder.type === 'deck' && supersededByBuilder.has(folder.id)) return false
    return true
  })

  // Two unlinked decks can still share a name by coincidence. Qualify only those,
  // so the common case stays clean.
  const nameCounts = kept.reduce((counts, folder) => {
    const key = folder.name?.trim().toLowerCase() || ''
    counts.set(key, (counts.get(key) || 0) + 1)
    return counts
  }, new Map())

  return kept
    .map(folder => {
      const ambiguous = (nameCounts.get(folder.name?.trim().toLowerCase() || '') || 0) > 1
      const qualifier = DECK_TYPE_LABEL[folder.type]
      return {
        id: folder.id,
        name: folder.name,
        type: folder.type,
        label: ambiguous && qualifier ? `${folder.name} · ${qualifier}` : folder.name,
      }
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      // Builder first for a coincidental name clash, matching the linked-pair rule.
      || (a.type === b.type ? 0 : a.type === 'builder_deck' ? -1 : 1))
}
