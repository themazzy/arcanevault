/**
 * Static constants used across the deck builder UI. Keep purely synchronous —
 * no React, no IDB, no network — so this module is safe to import anywhere.
 */

export const CAN_HOVER = typeof window !== 'undefined'
  && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches

export const RARITY_ORDER = ['mythic', 'rare', 'uncommon', 'common']
export const RARITY_COLORS = {
  mythic: '#e07020',
  rare: '#c9a84c',
  uncommon: '#a0a8b8',
  common: 'var(--text-faint)',
}

export const FOLDER_TAG_COLOR = {
  binder: 'rgba(201,168,76,0.18)',
  deck: 'rgba(138,111,196,0.18)',
  list: 'rgba(100,180,100,0.15)',
}
export const FOLDER_TAG_BORDER = {
  binder: 'rgba(201,168,76,0.35)',
  deck: 'rgba(138,111,196,0.35)',
  list: 'rgba(100,180,100,0.3)',
}

export const BOARD_ORDER = ['main', 'attraction', 'side', 'maybe']
export const BOARD_LABELS = {
  main: 'Mainboard',
  attraction: 'Attraction Deck',
  side: 'Sideboard',
  maybe: 'Maybeboard',
}
export const BOARD_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'main', label: 'Main' },
  { id: 'attraction', label: 'Attractions' },
  { id: 'side', label: 'Side' },
  { id: 'maybe', label: 'Maybe' },
]

export const UNCATEGORIZED = 'Uncategorized'

export const PIP_COLORS = {
  W: '#f8f0d8',
  U: '#4488cc',
  B: '#8855aa',
  R: '#cc4444',
  G: '#44884a',
  C: '#aaaaaa',
}

export const BASIC_LANDS = new Set(['Island', 'Plains', 'Forest', 'Mountain', 'Swamp', 'Wastes'])

export const DEFAULT_LIST_COLUMNS = {
  set: false,
  manaValue: true,
  cmc: false,
  price: true,
  status: true,
  actions: true,
  qty: true,
  remove: true,
}

export const DEFAULT_COMPACT_COLUMNS = {
  set: false,
  manaValue: false,
  cmc: false,
  price: false,
  status: false,
  actions: true,
  qty: false,
  remove: true,
}
