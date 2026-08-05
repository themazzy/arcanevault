// Card-type grouping — the single ladder behind every "by type" grouping in the
// app (deck builder, deck view, deck browser, binder/wishlist browsers, deck
// stats). It used to be copy-pasted into each of those files, which is how the
// artifact-land bug survived: fixing one copy left the rest wrong.
//
// Kept dependency-free on purpose so the collection-side browsers can import it
// without pulling in `deckBuilderApi` (Supabase + Scryfall + EDHREC).

export const TYPE_GROUPS = [
  'Commander', 'Creatures', 'Planeswalkers', 'Battles',
  'Instants', 'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other',
]

/**
 * Maps a type line onto exactly one display group.
 *
 * Order matters — a card can carry several types and only the first match wins:
 *
 *   • Lands are checked before Artifacts and Enchantments, so "Artifact Land"
 *     (Seat of the Synod, Darksteel Citadel) and "Enchantment Land" (Urza's
 *     Saga) group with the manabase. Nobody counts Seat of the Synod toward
 *     their artifact count, and burying lands in the Artifacts pile hides them
 *     from the one group a player actually scans for when checking mana.
 *   • Creature still outranks Land, so "Land Creature" (Dryad Arbor) stays with
 *     the creatures — it's the only card in the set and it's a creature you can
 *     attack with, which is what players look for it under.
 */
export function classifyCardType(typeLine = '') {
  const t = (typeLine || '').toLowerCase()
  if (t.includes('creature'))     return 'Creatures'
  if (t.includes('planeswalker')) return 'Planeswalkers'
  if (t.includes('battle'))       return 'Battles'
  if (t.includes('instant'))      return 'Instants'
  if (t.includes('sorcery'))      return 'Sorceries'
  if (t.includes('land'))         return 'Lands'
  if (t.includes('artifact'))     return 'Artifacts'
  if (t.includes('enchantment'))  return 'Enchantments'
  return 'Other'
}
