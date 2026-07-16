// Local-state isolation between accounts on a shared browser.
//
// DeckLoom's collection data lives in IndexedDB (keyed by user_id) and user
// preferences live in localStorage (NOT keyed by user). Nothing used to reset
// either when a different account signed in on the same browser, so a second
// Google account inherited the first account's nickname (making it look like
// the same user), skipped the setup wizard, and — because Profile ownership was
// decided by the leaked nickname — was even offered "Edit Profile" on the first
// user's page. This module tracks the active user id and wipes the previous
// user's local state whenever the signed-in identity changes.

import { clearUserScopedStores } from './db'

const ACTIVE_USER_KEY = 'deckloom_active_user_id'

// localStorage keys that hold one user's identity/data and must not bleed into
// the next account. Device-level caches (scryfall sets, scanner packs/prefs,
// news, game-changers), browser-level consent, and layout prefs are left in
// place on purpose — they carry no identity and are expensive to rebuild.
const USER_SCOPED_LS_KEYS = [
  'arcanevault_settings',          // theme, nickname, price source, all prefs
  'arcanevault_setup_done',        // first-run setup wizard gate
  'arcanevault_recently_viewed',   // Home "recently viewed" cards
  'arcanevault_manual_prices',     // manual per-card price overrides
  'arcanevault_theme_cache',       // cached theme vars for instant first paint
  'av_tournaments_v1',             // locally-stored tournaments
  'av_game_history',               // locally-stored game history
]

const USER_SCOPED_LS_PREFIXES = [
  'arcanevault_unlocked_milestones_',  // arcanevault_unlocked_milestones_<userId>
]

function readActiveUserId() {
  try { return localStorage.getItem(ACTIVE_USER_KEY) || null } catch { return null }
}

function writeActiveUserId(userId) {
  try {
    if (userId) localStorage.setItem(ACTIVE_USER_KEY, userId)
    else localStorage.removeItem(ACTIVE_USER_KEY)
  } catch { /* storage unavailable — nothing more we can do */ }
}

function clearUserScopedLocalStorage() {
  try {
    for (const key of USER_SCOPED_LS_KEYS) localStorage.removeItem(key)
    // Walk backwards so removals don't shift the indices we haven't visited yet.
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (key && USER_SCOPED_LS_PREFIXES.some(prefix => key.startsWith(prefix))) {
        localStorage.removeItem(key)
      }
    }
  } catch { /* storage unavailable */ }
}

let _wipePromise = null

// Called on every auth-state resolution with the currently signed-in user id
// (or null when signed out). When that id differs from the one this browser
// last recorded — an account switch or a sign-out — the previous user's local
// state is wiped. Returns a promise for the async IndexedDB wipe so callers can
// defer revealing the new session until the old data is gone (avoiding a read
// race where the new user's fresh sync gets clobbered by the wipe), or null
// when no wipe was needed.
export function reconcileActiveUser(newUserId) {
  const nextId = newUserId || null
  const storedId = readActiveUserId()

  if (storedId === nextId) return _wipePromise

  // Record the new identity synchronously, before the async wipe, so a
  // concurrent caller (getSession and onAuthStateChange both fire on load)
  // observes it and does not trigger a second wipe.
  writeActiveUserId(nextId)

  // First identity this browser has ever recorded — a fresh install, or the
  // first load after this code ships to an already-signed-in user. Adopt it
  // without wiping: there is no "previous user" whose data must be cleared.
  if (!storedId) return null

  clearUserScopedLocalStorage()
  _wipePromise = clearUserScopedStores()
    .catch(() => { /* best-effort; a failed wipe must not block auth */ })
    .finally(() => { _wipePromise = null })
  return _wipePromise
}

// Test seam.
export const __TESTING__ = { ACTIVE_USER_KEY, USER_SCOPED_LS_KEYS, USER_SCOPED_LS_PREFIXES }
