// Durable persistence for the life tracker.
//
// The previous implementation stored the live game in **sessionStorage**, which
// is destroyed when the tab closes or the OS reclaims the process. A phone left
// face-up on the table mid-game is exactly that case, so games routinely vanished
// even though every tap wrote synchronously. It also omitted the game log and the
// shared-session id from the payload, so a restore silently emptied the log and
// downgraded a shared game to a local one (no game_results rows for guests).
//
// This module fixes all three: localStorage, the complete game object, and a
// write that is flushed when the page is hidden rather than only on state change.

import { migrateGame } from './lifeGame'

export const GAME_KEY = 'av_life_game_v2'
export const SETUP_KEY = 'av_life_setup_v2'
// Pre-rewrite payload, read once so an in-progress game survives the deploy.
export const LEGACY_GAME_KEY = 'av_life_tracker'

// Older than this and we offer it as "resume" rather than dropping the user
// straight back into a game they finished playing yesterday.
export const MAX_AUTO_RESUME_MS = 12 * 60 * 60 * 1000
export const MAX_KEEP_MS = 7 * 24 * 60 * 60 * 1000

// Leading-edge write so the first tap is durable immediately, then a trailing
// write coalesces a flurry of taps into one serialization.
export const WRITE_THROTTLE_MS = 400

// Private-mode Safari and full quotas throw on setItem. Falling back to memory
// keeps the game alive across in-app navigation even when disk is unavailable.
const memoryFallback = new Map()

function readRaw(key) {
  try {
    const hit = localStorage.getItem(key)
    if (hit != null) return hit
  } catch { /* fall through to memory */ }
  return memoryFallback.has(key) ? memoryFallback.get(key) : null
}

function writeRaw(key, value) {
  memoryFallback.set(key, value)
  try { localStorage.setItem(key, value) } catch { /* memory already holds it */ }
}

function removeRaw(key) {
  memoryFallback.delete(key)
  try { localStorage.removeItem(key) } catch { /* nothing to do */ }
}

function readJson(key) {
  const raw = readRaw(key)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// ── Game ───────────────────────────────────────────────────────────────────────

/**
 * @returns {{ game: object, savedAt: number, canAutoResume: boolean } | null}
 */
export function loadGame() {
  const record = readJson(GAME_KEY)
  if (record?.game) {
    const age = Date.now() - (record.savedAt || 0)
    if (age > MAX_KEEP_MS) { removeRaw(GAME_KEY); return null }
    const game = migrateGame(record.game)
    if (!game) return null
    return { game, savedAt: record.savedAt || 0, canAutoResume: age <= MAX_AUTO_RESUME_MS }
  }

  const legacy = readLegacyGame()
  if (legacy) return legacy
  return null
}

// The old payload was { screen: 'playing', config, players, startedAt } in
// sessionStorage. Read it once, hand it to migrateGame, then drop the key.
function readLegacyGame() {
  let raw
  try { raw = sessionStorage.getItem(LEGACY_GAME_KEY) } catch { return null }
  if (!raw) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch { /* unreadable — drop it below */ }
  try { sessionStorage.removeItem(LEGACY_GAME_KEY) } catch { /* best effort */ }
  if (parsed?.screen !== 'playing') return null
  const game = migrateGame(parsed)
  if (!game) return null
  return { game, savedAt: Date.now(), canAutoResume: true }
}

let pendingGame = null
let writeTimer = null
let lastWriteAt = 0

export function saveGame(game) {
  if (!game) return
  pendingGame = game
  const since = Date.now() - lastWriteAt
  if (since >= WRITE_THROTTLE_MS) {
    flushGame()
  } else if (writeTimer == null) {
    writeTimer = setTimeout(flushGame, WRITE_THROTTLE_MS - since)
  }
}

export function flushGame() {
  if (writeTimer != null) { clearTimeout(writeTimer); writeTimer = null }
  if (!pendingGame) return
  lastWriteAt = Date.now()
  writeRaw(GAME_KEY, JSON.stringify({ savedAt: lastWriteAt, game: pendingGame }))
  pendingGame = null
}

export function clearGame() {
  if (writeTimer != null) { clearTimeout(writeTimer); writeTimer = null }
  pendingGame = null
  removeRaw(GAME_KEY)
}

/**
 * Flush on the events that actually precede a process death. 'visibilitychange'
 * covers backgrounding on Android/iOS; 'pagehide' covers navigation and tab close.
 * 'beforeunload' is deliberately not used — it is unreliable on mobile and blocks
 * the back/forward cache.
 * @returns {() => void} cleanup
 */
export function registerFlushHooks() {
  const onHide = () => { if (document.visibilityState === 'hidden') flushGame() }
  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', flushGame)
  return () => {
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('pagehide', flushGame)
    flushGame()
  }
}

// ── Setup preferences ──────────────────────────────────────────────────────────
// Format / seat count / layout choices persist on their own so that leaving the
// page before starting a game doesn't reset them to Commander-4 every time.

const SETUP_DEFAULTS = { format: 'commander', seatCount: 4, customLife: 20, layoutId: null }

export function loadSetup() {
  const saved = readJson(SETUP_KEY)
  if (!saved || typeof saved !== 'object') return { ...SETUP_DEFAULTS }
  return {
    format: typeof saved.format === 'string' ? saved.format : SETUP_DEFAULTS.format,
    seatCount: Number(saved.seatCount) || SETUP_DEFAULTS.seatCount,
    customLife: Number(saved.customLife) || SETUP_DEFAULTS.customLife,
    layoutId: typeof saved.layoutId === 'string' ? saved.layoutId : null,
  }
}

export function saveSetup(setup) {
  writeRaw(SETUP_KEY, JSON.stringify({
    format: setup.format,
    seatCount: setup.seatCount,
    customLife: setup.customLife,
    layoutId: setup.layoutId ?? null,
  }))
}

// Test hook: module-level throttle state would otherwise leak between cases.
export function __resetStorageForTests() {
  if (writeTimer != null) { clearTimeout(writeTimer); writeTimer = null }
  pendingGame = null
  lastWriteAt = 0
  memoryFallback.clear()
}
