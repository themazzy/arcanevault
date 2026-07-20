// Decides which Home layout a user sees.
//
// 'onboarding'  — feature showcase first (Build Assist / Collection / Scanner):
//                 the user has no owned cards AND no Builder decks, so the
//                 dashboard would be a wall of empty sections.
// 'dashboard'   — quick-actions strip + collection dashboard.
// 'loading'     — neutral holding state while the account signal is unresolved.
//
// Do not guess a layout while data is loading: either guess can flash the wrong
// experience before the account state resolves.
export function getHomeMode({ loading, cardCount, builderDeckCount }) {
  if (loading) return 'loading'
  if (cardCount > 0 || builderDeckCount > 0) return 'dashboard'
  return 'onboarding'
}

const UPCOMING_SET_TYPES = new Set([
  'expansion',
  'core',
  'masters',
  'draft_innovation',
  'commander',
  'starter_deck',
])

export function selectUpcomingSets(sets, today) {
  return (sets || [])
    .filter(set => set.released_at > today && UPCOMING_SET_TYPES.has(set.set_type))
    .sort((a, b) => a.released_at.localeCompare(b.released_at))
}
