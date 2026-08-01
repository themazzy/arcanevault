export function isNetworkLikeError(err) {
  if (!navigator.onLine) return true
  const msg = String(err?.message || '').toLowerCase()
  return msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('load failed')
}

export function createOfflineError(message = 'Offline') {
  const error = new Error(message)
  error.name = 'OfflineError'
  return error
}

/**
 * Throw before spending a round trip we know will fail. Reads require
 * connectivity (the app is IDB-cached, not offline-first), so the useful
 * behaviour is a named OfflineError callers can recognise — rather than the
 * raw "Failed to fetch" a doomed request eventually produces.
 */
export function assertOnline(message) {
  if (!navigator.onLine) throw createOfflineError(message)
}

export function isOfflineError(err) {
  return err?.name === 'OfflineError'
}
