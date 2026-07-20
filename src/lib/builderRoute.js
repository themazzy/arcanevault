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
