// The one place a rarity's label and colour are defined.
//
// These lived as a module-local const inside CardComponents.jsx, which meant a
// second surface showing rarities had to either import that whole module or
// re-pick the colours — and re-picking is what happened: the spoiler page
// shipped with its own uncommon and mythic hexes, so one rarity was two colours
// depending on which page you were looking at.
//
// Ordered common -> special, matching how the collection filter bar lists them.
export const RARITY_META = [
  { id: 'common',   label: 'Common',   color: '#6a6a7a' },
  { id: 'uncommon', label: 'Uncommon', color: '#8ab0c8' },
  { id: 'rare',     label: 'Rare',     color: '#c9a84c' },
  { id: 'mythic',   label: 'Mythic',   color: '#c46030' },
  { id: 'special',  label: 'Special',  color: '#8a6fc4' },
]

const COLOR_BY_ID = new Map(RARITY_META.map(r => [r.id, r.color]))

/** Falls back to the common grey, so an unknown rarity is quiet, not invisible. */
export function rarityColor(id) {
  return COLOR_BY_ID.get(id) || COLOR_BY_ID.get('common')
}

export function rarityLabel(id) {
  return RARITY_META.find(r => r.id === id)?.label || id
}
