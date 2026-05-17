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

// Always returns the production origin regardless of build env. Use for links
// that must reach the live site even when generated from a dev or Capacitor
// build — e.g. Supabase confirmation / password-reset emails, where pointing
// at localhost would leave the user stranded.
export function getProdAppUrl(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${PROD_ORIGIN}${normalizedPath}`
}
