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

// Share link for a public deck. Points at the `og-deck` edge function rather
// than directly at /d/<id>: the function serves rich Open Graph previews to
// link crawlers (Facebook, Discord, …) and 302-redirects real browsers on to
// https://deckloom.app/d/<id>. GitHub Pages is static and can't do that itself.
// FB still shows DECKLOOM.APP as the source label (via og:url on the function).
export function getDeckShareUrl(deckId) {
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  if (!supabaseUrl) return getPublicAppUrl(`/d/${deckId}`)
  return `${supabaseUrl}/functions/v1/og-deck/${deckId}`
}

// Always returns the production origin regardless of build env. Use for links
// that must reach the live site even when generated from a dev or Capacitor
// build — e.g. Supabase confirmation / password-reset emails, where pointing
// at localhost would leave the user stranded.
export function getProdAppUrl(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${PROD_ORIGIN}${normalizedPath}`
}
