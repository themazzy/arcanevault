// Decides which Home layout a user sees.
//
// 'onboarding'  — feature showcase first (Build Assist / Collection / Scanner):
//                 the user has no cards AND no folders, so the dashboard would
//                 be a wall of empty sections.
// 'dashboard'   — quick-actions strip + collection dashboard.
//
// While collection data is still loading we show the dashboard (its sections
// already render skeletons); flipping to onboarding only after data resolves
// empty avoids flashing marketing at established users on every visit.
export function getHomeMode({ loading, cardCount, folderCount }) {
  if (loading) return 'dashboard'
  if (cardCount > 0 || folderCount > 0) return 'dashboard'
  return 'onboarding'
}
