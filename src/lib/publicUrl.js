const PROD_ORIGIN = 'https://deckloom.app'

export function getPublicBaseUrl() {
  if (import.meta.env.VITE_CAPACITOR) {
    return PROD_ORIGIN
  }
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
  return `${window.location.origin}${base}`
}

export function getPublicAppUrl(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getPublicBaseUrl()}${normalizedPath}`
}
