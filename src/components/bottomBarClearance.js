/**
 * Bottom-bar clearance for floating overlays (today: the toast stack).
 *
 * Several surfaces pin furniture to the bottom of the viewport on small
 * screens — the browse toolbar, the bulk action bar, DeckBuilder's toolbar, the
 * scanner's own bar. Anything else anchored to the bottom has to clear whatever
 * is currently mounted.
 *
 * Making each toast call site declare that failed in practice: of ~80 calls in
 * the app exactly one ever passed a placement, so every other toast rendered on
 * top of the bar. The knowledge belongs to the bar, not to the caller — so the
 * bar registers itself here while mounted and the overlay reads one variable.
 *
 * Registration writes `--toast-bottom-clearance` on <html>:
 *
 *   .toastStack { bottom: calc(<base> + var(--toast-bottom-clearance, 0px)); }
 *
 * Heights are CSS length STRINGS, not numbers, so a bar passes its own token
 * (`var(--mobile-floating-bar-height)`) and the two can never drift. Several
 * bars can be mounted at once — a browse surface shows its toolbar and the bulk
 * bar together in select mode — so simultaneous claims resolve through CSS
 * `max()`, which compares token references the way JS cannot.
 */

import { useEffect } from 'react'

export const CLEARANCE_VAR = '--toast-bottom-clearance'

// Tallest wins. Returns a CSS length, or null when nothing is claiming.
export function resolveClearance(values) {
  const lengths = [...(values || [])].filter(Boolean)
  if (!lengths.length) return null
  if (lengths.length === 1) return lengths[0]
  // Deduplicated and ordered so the emitted value is stable regardless of
  // mount order — otherwise the style attribute churns on every remount.
  const unique = [...new Set(lengths)].sort()
  return unique.length === 1 ? unique[0] : `max(${unique.join(', ')})`
}

const claims = new Map()
let nextClaimId = 0

function applyClaims() {
  if (typeof document === 'undefined') return
  const value = resolveClearance(claims.values())
  const root = document.documentElement
  if (value) root.style.setProperty(CLEARANCE_VAR, value)
  else root.style.removeProperty(CLEARANCE_VAR)
}

// Test seam — the claim map is module state shared by every mounted bar.
export function __resetClearanceClaims() {
  claims.clear()
  applyClaims()
}

/**
 * Reserve `height` at the bottom of the viewport while this component is
 * mounted and `query` matches.
 *
 * @param {object}  opts
 * @param {boolean} opts.active  false while the bar is not rendered at all
 * @param {string}  opts.height  CSS length — pass the bar's own token
 * @param {string}  [opts.query] media query the bar is bottom-pinned under.
 *                               Omit for a bar that is pinned at every width
 *                               (the scanner's, which is full-screen on tablets
 *                               too). Must match the query in the bar's CSS, or
 *                               the overlay floats over nothing on desktop.
 */
export function useBottomBarClearance({ active = true, height, query } = {}) {
  useEffect(() => {
    if (!active || !height || typeof window === 'undefined') return undefined
    const id = ++nextClaimId
    // A WebView without matchMedia claims unconditionally: over-clearing looks
    // slightly off, under-clearing hides a control behind the bar.
    const mq = query && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
    const sync = () => {
      if (!mq || mq.matches) claims.set(id, height)
      else claims.delete(id)
      applyClaims()
    }
    sync()
    mq?.addEventListener?.('change', sync)
    return () => {
      mq?.removeEventListener?.('change', sync)
      claims.delete(id)
      applyClaims()
    }
  }, [active, height, query])
}

// The breakpoints below MUST match the media query each bar's CSS uses to go
// `position: fixed`. They are duplicated here because var() is not allowed in a
// media query, so neither side can read the other.
export const MOBILE_TOOLBAR_HEIGHT = 'var(--mobile-floating-bar-height)'
export const SCANNER_BAR_HEIGHT = 'var(--scanner-bottom-bar-height)'
export const BULK_BAR_HEIGHT = 'var(--bulk-bar-height)'
// UI.module.css .headerFloatingToolbar
export const HEADER_TOOLBAR_QUERY = '(max-width: 980px)'
// DeckBuilder.module.css .deckToolbar
export const DECK_TOOLBAR_QUERY = '(max-width: 900px)'
// CardComponents.module.css .bulkBarFloatingMobile
export const BULK_BAR_QUERY = '(max-width: 620px)'
