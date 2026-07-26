// Which folders the scanner may save scanned cards into.
//
// Scanned cards are owned inventory, so a destination must be a folder that
// physically holds cards: a binder, a *collection* deck, or a wishlist.
// Builder decks (`builder_deck`) track intended contents in deck_cards, not
// ownership — listing them duplicated every linked deck pair in the picker
// (both sides share a name) and offered a destination whose writes would land
// in the wrong table. Group folders are organisational containers and hold no
// cards at all.

import { isGroupFolder } from '../lib/collectionFetchers'

export const SAVE_DESTINATION_TYPES = ['binder', 'deck', 'list']

export function isSaveDestinationType(type) {
  return SAVE_DESTINATION_TYPES.includes(type)
}

export function isSaveDestinationFolder(folder) {
  return !!folder && isSaveDestinationType(folder.type) && !isGroupFolder(folder)
}

// Destinations of one type, optionally narrowed by the picker's search box.
export function filterDestinationFolders(folders, { type, search = '' } = {}) {
  const query = String(search || '').trim().toLowerCase()
  return (folders || []).filter(folder => (
    isSaveDestinationFolder(folder) &&
    folder.type === type &&
    (!query || String(folder.name || '').toLowerCase().includes(query))
  ))
}

// Does a destination of this type already carry this exact name? Gates the
// picker's "create folder" affordance.
export function hasDestinationNamed(folders, { type, name }) {
  const target = String(name || '').trim().toLowerCase()
  if (!target) return false
  return (folders || []).some(folder => (
    isSaveDestinationFolder(folder) &&
    folder.type === type &&
    String(folder.name || '').trim().toLowerCase() === target
  ))
}
