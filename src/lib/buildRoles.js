// The coarse build-role vocabulary, in its own module.
//
// These live here rather than in deckBuildAssistant because several modules need
// the constants AND deckBuildAssistant needs those modules back. cardRoles
// importing them from deckBuildAssistant closed a loop that left them undefined
// at module-init time and silently zeroed the multi-role signal — no error, just
// a number that quietly became 0. Constants have no dependencies, so a leaf
// module is where they belong.

export const ROLE_RAMP = 'Ramp'
export const ROLE_DRAW = 'Draw'
export const ROLE_REMOVAL = 'Removal'
export const ROLE_WIPE = 'Board Wipe'
export const ROLE_PROTECTION = 'Protection'
export const ROLE_WINCON = 'Game Plan / Win Cons'
export const ROLE_SYNERGY = 'Synergy'
export const ROLE_LANDS = 'Lands'

// Display + iteration order for the wizard (Lands last — handled separately by
// most players, and Synergy is the catch-all remainder before it).
export const ROLE_ORDER = [
  ROLE_RAMP,
  ROLE_DRAW,
  ROLE_REMOVAL,
  ROLE_WIPE,
  ROLE_PROTECTION,
  ROLE_WINCON,
  ROLE_SYNERGY,
  ROLE_LANDS,
]
