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
