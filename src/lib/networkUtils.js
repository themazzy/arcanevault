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
