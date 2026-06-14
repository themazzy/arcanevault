// Pure printing-selection for the deck-builder "Optimize printings" action.
// Given all paper printings of a card (Scryfall card objects, with
// released_at + prices), pick the one matching the chosen strategy.
//
// Modes:
//   cheapest / expensive  — by price in the active source for the given finish
//   oldest / newest       — by released_at
// (the 'foil' / 'nonfoil' modes only flip the finish and don't pick a
//  printing, so they're handled by the caller, not here)

import { getPrice } from './scryfall'

export const PRINTING_MODES = [
  { id: 'cheapest',  label: 'Cheapest printing' },
  { id: 'expensive', label: 'Most expensive printing' },
  { id: 'oldest',    label: 'Oldest printing' },
  { id: 'newest',    label: 'Newest printing' },
  { id: 'foil',      label: 'All foil' },
  { id: 'nonfoil',   label: 'All non-foil' },
]

export const PRINTING_MODE_IDS = new Set(PRINTING_MODES.map(m => m.id))

export function pickPrintingForMode(prints, mode, { foil = false, priceSource } = {}) {
  const list = (prints || []).filter(Boolean)
  if (!list.length) return null

  if (mode === 'newest' || mode === 'oldest') {
    return list.reduce((best, p) => {
      const a = best.released_at || ''
      const b = p.released_at || ''
      if (mode === 'newest') return b > a ? p : best
      return b && (!a || b < a) ? p : best
    })
  }

  if (mode === 'cheapest' || mode === 'expensive') {
    const priced = list
      .map(p => ({ p, price: getPrice(p, foil, { price_source: priceSource }) }))
      .filter(x => x.price != null)
    if (!priced.length) return null
    return priced.reduce((best, x) =>
      mode === 'cheapest'
        ? (x.price < best.price ? x : best)
        : (x.price > best.price ? x : best)
    ).p
  }

  return null
}
