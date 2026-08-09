// Shared oracle-text helpers.
//
// Lives in its own module to keep the dependency graph acyclic: both cardRoles
// and engineEnablers need this, engineEnablers is imported by
// deckBuildAssistant, and cardRoles imports the role constants back out of
// deckBuildAssistant. Having engineEnablers reach into cardRoles closed that
// loop, which left the role constants undefined at module-init time and
// silently zeroed the multi-role signal — a failure with no error, only a
// number that quietly became 0.

/**
 * Strip parenthetical reminder text before matching.
 *
 * Scryfall bakes reminder text into oracle_text, and it is a real
 * false-positive source: every Treasure-making card carries "(It's an artifact
 * with "{T}, Sacrifice this token: Add one mana of any color.")", which a
 * mana-production or sacrifice-outlet rule would otherwise read as the CARD
 * doing those things. Mana costs are unaffected — they're braces, not parens.
 */
export function stripReminders(oracle = '') {
  return String(oracle).replace(/\([^)]*\)/g, ' ')
}

/**
 * Whole-card rules text: front face plus every card_faces entry, reminder-
 * stripped and lowercased. A back-face Armageddon or an MDFC's land half is
 * part of what the card does, so it must be in scope.
 *
 * `sfCard` is the cached Scryfall/card_prints entry, `card` the local row —
 * only the row is guaranteed present, and single-faced cards carry their text
 * at the top level while DFCs carry it per face.
 *
 * Reminder text stays stripped for search as well as for role matching: it
 * restates rules the card already spells out, so it adds no reachable card and
 * only widens false positives.
 */
export function allFacesOracleText(sfCard, card) {
  const parts = []
  const top = sfCard?.oracle_text ?? card?.oracle_text
  if (top) parts.push(top)
  for (const f of sfCard?.card_faces || []) if (f?.oracle_text) parts.push(f.oracle_text)
  return stripReminders(parts.join('\n')).toLowerCase()
}
