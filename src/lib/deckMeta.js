// Deck metadata helpers and the format list, kept apart from deckBuilderApi so
// modules on the first-load path (the app shell, the public deck view) can use
// them without pulling the whole builder API, Scryfall client and card-search
// stack into the entry bundle. deckBuilderApi re-exports all three.

export const FORMATS = [
  { id: 'commander',     label: 'Commander / EDH', isEDH: true,  deckSize: 100 },
  { id: 'oathbreaker',   label: 'Oathbreaker',     isEDH: true,  deckSize: 60,  isOathbreaker: true },
  { id: 'brawl',         label: 'Brawl',           isEDH: true,  deckSize: 100 },
  { id: 'standardbrawl', label: 'Standard Brawl',  isEDH: true,  deckSize: 60  },
  { id: 'standard',      label: 'Standard',        isEDH: false, deckSize: 60  },
  { id: 'modern',        label: 'Modern',          isEDH: false, deckSize: 60  },
  { id: 'pioneer',       label: 'Pioneer',         isEDH: false, deckSize: 60  },
  { id: 'legacy',        label: 'Legacy',          isEDH: false, deckSize: 60  },
  { id: 'vintage',       label: 'Vintage',         isEDH: false, deckSize: 60  },
  { id: 'pauper',        label: 'Pauper',          isEDH: false, deckSize: 60  },
]

// Stored in folders.description as JSON.
export function parseDeckMeta(description) {
  try { return JSON.parse(description || '{}') }
  catch { return {} }
}

export function serializeDeckMeta(meta) {
  return JSON.stringify(meta)
}
