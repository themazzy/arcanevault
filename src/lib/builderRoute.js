export function getBuilderIndexIntent(search = '') {
  const params = new URLSearchParams(search)
  return {
    pageTab: params.get('tab') === 'browser' ? 'community' : 'my',
    openNewDeck: params.get('new') === '1',
  }
}

export function clearNewDeckIntent(search = '') {
  const params = new URLSearchParams(search)
  params.delete('new')
  const next = params.toString()
  return next ? `?${next}` : ''
}

const BUILDER_DECK_PATH = /^\/builder\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i

// A deck link copied out of the builder's address bar is the editor URL, not the
// share URL. Signed in, DeckBuilder already bounces a non-owner to /d/:id; signed
// out the login gate runs first, so a shared link dead-ends on the login page.
// Returns the deck id for such a URL, or null for anything else (/builder itself,
// /builder/:id/playtest, a non-UUID segment).
export function builderDeckIdFromPath(pathname = '') {
  const match = BUILDER_DECK_PATH.exec(pathname)
  return match ? match[1] : null
}
