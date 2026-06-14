// Shared basic-land definitions — used by the deck-builder "Add basic lands"
// helper and to exclude basics from the acquisition buylist.

export const BASIC_LAND_TYPES = [
  { name: 'Plains',   color: 'W', symbol: '{W}' },
  { name: 'Island',   color: 'U', symbol: '{U}' },
  { name: 'Swamp',    color: 'B', symbol: '{B}' },
  { name: 'Mountain', color: 'R', symbol: '{R}' },
  { name: 'Forest',   color: 'G', symbol: '{G}' },
  { name: 'Wastes',   color: 'C', symbol: '{C}' },
]

// Names (lower-case) of every basic land, including Snow-Covered variants, so
// callers can cheaply test "is this card a basic land?".
export const BASIC_LAND_NAMES = new Set(
  BASIC_LAND_TYPES.flatMap(b => [b.name.toLowerCase(), `snow-covered ${b.name.toLowerCase()}`])
)

export function isBasicLandName(name) {
  return BASIC_LAND_NAMES.has(String(name || '').trim().toLowerCase())
}
