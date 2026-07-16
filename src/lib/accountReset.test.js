import { describe, it, expect, vi, beforeEach } from 'vitest'

// The IDB wipe is exercised separately; here we only care that reconcile calls
// it at the right times, so stub it with a resolved spy.
const clearUserScopedStores = vi.fn(async () => {})
vi.mock('./db', () => ({ clearUserScopedStores: (...args) => clearUserScopedStores(...args) }))

// Minimal synchronous localStorage stand-in (jsdom provides one too, but an
// explicit map keeps the assertions obvious and isolated per test).
function installLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  const ls = {
    get length() { return store.size },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
  }
  vi.stubGlobal('localStorage', ls)
  return store
}

async function importFresh() {
  vi.resetModules()
  return import('./accountReset')
}

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ACTIVE_KEY = 'deckloom_active_user_id'

beforeEach(() => {
  clearUserScopedStores.mockClear()
})

describe('reconcileActiveUser', () => {
  it('adopts the first identity without wiping (fresh install / first load after ship)', async () => {
    const store = installLocalStorage({
      arcanevault_settings: '{"nickname":"Existing"}',
    })
    const { reconcileActiveUser } = await importFresh()

    const wipe = reconcileActiveUser(USER_A)

    expect(wipe).toBeNull()
    expect(clearUserScopedStores).not.toHaveBeenCalled()
    expect(store.get(ACTIVE_KEY)).toBe(USER_A)
    // Existing user's settings are preserved on upgrade.
    expect(store.get('arcanevault_settings')).toBe('{"nickname":"Existing"}')
  })

  it('does nothing when the same user resolves again (normal reload / token refresh)', async () => {
    const store = installLocalStorage({ [ACTIVE_KEY]: USER_A })
    const { reconcileActiveUser } = await importFresh()

    const wipe = reconcileActiveUser(USER_A)

    expect(wipe).toBeNull()
    expect(clearUserScopedStores).not.toHaveBeenCalled()
    expect(store.get(ACTIVE_KEY)).toBe(USER_A)
  })

  it('wipes local state when a different account signs in', async () => {
    const store = installLocalStorage({
      [ACTIVE_KEY]: USER_A,
      arcanevault_settings: '{"nickname":"Lilliana_Vess"}',
      arcanevault_setup_done: '1',
      arcanevault_manual_prices: '{}',
      arcanevault_theme_cache: '{}',
      arcanevault_recently_viewed: '[]',
      av_tournaments_v1: '[]',
      av_game_history: '[]',
      [`arcanevault_unlocked_milestones_${USER_A}`]: '["first"]',
      // Device-level caches that must survive the switch:
      av_scryfall_sets: 'cached',
      arcanevault_scanner_used: '1',
      arcanevault_consent_v1: 'granted',
    })
    const { reconcileActiveUser } = await importFresh()

    const wipe = reconcileActiveUser(USER_B)

    expect(wipe).toBeInstanceOf(Promise)
    await wipe
    expect(clearUserScopedStores).toHaveBeenCalledTimes(1)
    expect(store.get(ACTIVE_KEY)).toBe(USER_B)
    // User-scoped keys gone (including the previous user's milestone key)...
    expect(store.has('arcanevault_settings')).toBe(false)
    expect(store.has('arcanevault_setup_done')).toBe(false)
    expect(store.has('arcanevault_manual_prices')).toBe(false)
    expect(store.has('arcanevault_theme_cache')).toBe(false)
    expect(store.has('arcanevault_recently_viewed')).toBe(false)
    expect(store.has('av_tournaments_v1')).toBe(false)
    expect(store.has('av_game_history')).toBe(false)
    expect(store.has(`arcanevault_unlocked_milestones_${USER_A}`)).toBe(false)
    // ...device-level caches survive.
    expect(store.get('av_scryfall_sets')).toBe('cached')
    expect(store.get('arcanevault_scanner_used')).toBe('1')
    expect(store.get('arcanevault_consent_v1')).toBe('granted')
  })

  it('wipes local state on sign-out (id -> null)', async () => {
    const store = installLocalStorage({
      [ACTIVE_KEY]: USER_A,
      arcanevault_settings: '{"nickname":"Lilliana_Vess"}',
      arcanevault_setup_done: '1',
    })
    const { reconcileActiveUser } = await importFresh()

    const wipe = reconcileActiveUser(null)

    await wipe
    expect(clearUserScopedStores).toHaveBeenCalledTimes(1)
    expect(store.has(ACTIVE_KEY)).toBe(false)
    expect(store.has('arcanevault_settings')).toBe(false)
    expect(store.has('arcanevault_setup_done')).toBe(false)
  })

  it('does not double-wipe when getSession and onAuthStateChange both fire for the same switch', async () => {
    installLocalStorage({ [ACTIVE_KEY]: USER_A })
    const { reconcileActiveUser } = await importFresh()

    const first = reconcileActiveUser(USER_B)
    const second = reconcileActiveUser(USER_B)

    await Promise.all([first, second])
    // Only the first call performs the wipe; the second sees the already-updated
    // active id and no-ops (returning the in-flight promise it can await).
    expect(clearUserScopedStores).toHaveBeenCalledTimes(1)
  })
})
