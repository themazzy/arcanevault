const CHUNK_RELOAD_KEY = 'deckloom_chunk_reload'
const CHUNK_RELOAD_TTL_MS = 10_000

export function isChunkLoadError(error) {
  const message = String(error?.message || error || '')
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(message)
}

function recentlyReloaded() {
  try {
    const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0)
    return Number.isFinite(lastReload) && Date.now() - lastReload < CHUNK_RELOAD_TTL_MS
  } catch {
    return false
  }
}

export function reloadForFreshChunks() {
  if (recentlyReloaded()) return false
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  } catch {
    // Ignore storage failures; reloading is still the best recovery path.
  }
  window.location.reload()
  return true
}

export function handleChunkLoadError(error) {
  if (!isChunkLoadError(error)) return false
  return reloadForFreshChunks()
}
