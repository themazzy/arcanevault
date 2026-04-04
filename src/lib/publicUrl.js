const PROD_ORIGIN = 'https://themazzy.github.io'
const PROD_BASE = '/arcanevault'

export function getPublicBaseUrl() {
  if (import.meta.env.VITE_CAPACITOR) {
    return `${PROD_ORIGIN}${PROD_BASE}`
  }
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
  return `${window.location.origin}${base}`
}

export function getPublicAppUrl(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getPublicBaseUrl()}${normalizedPath}`
}
