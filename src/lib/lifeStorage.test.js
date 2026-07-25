// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GAME_KEY, SETUP_KEY, LEGACY_GAME_KEY, WRITE_THROTTLE_MS, MAX_AUTO_RESUME_MS, MAX_KEEP_MS,
  loadGame, saveGame, flushGame, clearGame, registerFlushHooks,
  loadSetup, saveSetup, __resetStorageForTests,
} from './lifeStorage'
import { createGame, gameReducer } from './lifeGame'

const stored = () => JSON.parse(localStorage.getItem(GAME_KEY))

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetStorageForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  // The storage-failure case spies on Storage.prototype; a leaked spy would make
  // every later test throw QuotaExceededError.
  vi.restoreAllMocks()
})

describe('saveGame / loadGame', () => {
  it('writes the first save immediately so a crash right after a tap is survivable', () => {
    const game = gameReducer(createGame({ format: 'standard', seatCount: 2 }), { type: 'life', id: 0, delta: -5, ts: 1 })
    saveGame(game)
    expect(stored().game.players[0].life).toBe(15)
  })

  it('persists to localStorage, not sessionStorage — the original bug', () => {
    saveGame(createGame({ format: 'standard', seatCount: 2 }))
    expect(localStorage.getItem(GAME_KEY)).toBeTruthy()
    expect(sessionStorage.getItem(GAME_KEY)).toBeNull()
  })

  it('round-trips the whole game including the log and session id', () => {
    let game = createGame({ format: 'commander', seatCount: 4, sessionId: 'sess-9' })
    game = gameReducer(game, { type: 'life', id: 2, delta: -7, ts: 1000 })
    game = gameReducer(game, { type: 'cmdDamage', id: 0, fromId: 1, slot: 1, delta: 6, ts: 2000 })
    saveGame(game)

    const loaded = loadGame()
    expect(loaded.game.sessionId).toBe('sess-9')
    expect(loaded.game.log).toHaveLength(2)
    expect(loaded.game.players[2].life).toBe(33)
    expect(loaded.game.players[0].dmg[1]).toEqual([0, 6])
    expect(loaded.canAutoResume).toBe(true)
  })

  it('coalesces a flurry of taps into one trailing write', () => {
    let game = createGame({ format: 'standard', seatCount: 2 })
    saveGame(game)                       // leading write
    for (let i = 0; i < 8; i++) {
      game = gameReducer(game, { type: 'life', id: 0, delta: -1, ts: 1000 + i })
      saveGame(game)
    }
    expect(stored().game.players[0].life).toBe(20)   // still the leading snapshot
    vi.advanceTimersByTime(WRITE_THROTTLE_MS)
    expect(stored().game.players[0].life).toBe(12)   // trailing write caught up
  })

  it('flushGame writes the pending state right away', () => {
    let game = createGame({ format: 'standard', seatCount: 2 })
    saveGame(game)
    game = gameReducer(game, { type: 'life', id: 0, delta: -4, ts: 1 })
    saveGame(game)
    flushGame()
    expect(stored().game.players[0].life).toBe(16)
  })

  it('clearGame removes the record and cancels a pending write', () => {
    let game = createGame({ format: 'standard', seatCount: 2 })
    saveGame(game)
    game = gameReducer(game, { type: 'life', id: 0, delta: -4, ts: 1 })
    saveGame(game)
    clearGame()
    vi.advanceTimersByTime(WRITE_THROTTLE_MS * 3)
    expect(localStorage.getItem(GAME_KEY)).toBeNull()
    expect(loadGame()).toBeNull()
  })

  it('returns null when nothing is stored', () => {
    expect(loadGame()).toBeNull()
  })

  it('ignores an unparseable record instead of throwing', () => {
    localStorage.setItem(GAME_KEY, '{not json')
    expect(loadGame()).toBeNull()
  })

  it('ignores a record whose game cannot be migrated', () => {
    localStorage.setItem(GAME_KEY, JSON.stringify({ savedAt: Date.now(), game: { players: [] } }))
    expect(loadGame()).toBeNull()
  })
})

describe('resume age', () => {
  it('offers a stale-but-recent game without auto-resuming it', () => {
    saveGame(createGame({ format: 'standard', seatCount: 2 }))
    const record = stored()
    record.savedAt = Date.now() - (MAX_AUTO_RESUME_MS + 60_000)
    localStorage.setItem(GAME_KEY, JSON.stringify(record))

    const loaded = loadGame()
    expect(loaded).not.toBeNull()
    expect(loaded.canAutoResume).toBe(false)
  })

  it('drops and forgets a game older than the keep window', () => {
    saveGame(createGame({ format: 'standard', seatCount: 2 }))
    const record = stored()
    record.savedAt = Date.now() - (MAX_KEEP_MS + 60_000)
    localStorage.setItem(GAME_KEY, JSON.stringify(record))

    expect(loadGame()).toBeNull()
    expect(localStorage.getItem(GAME_KEY)).toBeNull()
  })
})

describe('legacy sessionStorage migration', () => {
  const legacy = {
    screen: 'playing',
    startedAt: 1700000000000,
    config: { mode: 'commander', playerCount: 3, layout: { rotations: { 0: 180, 1: 180 } } },
    players: [
      { id: 0, name: 'Jan', color: '#c46060', life: 18, cmdDmg: { 1: 9 }, cmdDmg2: { 1: 4 },
        cmdTax: 2, cmdTax2: 0, counters: { poison: 2, energy: 0, experience: 0 }, artCropUrl: 'https://x/a.jpg' },
      { id: 1, name: 'Ada', color: '#6080c4', life: 40, hasPartner: true },
      { id: 2, name: 'Lee', color: '#60a860', life: 27 },
    ],
  }

  it('picks up an in-flight game from the pre-rewrite key', () => {
    sessionStorage.setItem(LEGACY_GAME_KEY, JSON.stringify(legacy))
    const loaded = loadGame()
    expect(loaded.game.players.map(p => p.life)).toEqual([18, 40, 27])
    expect(loaded.game.players[0].dmg[1]).toEqual([9, 4])
    expect(loaded.game.players[0].tax).toEqual([2, 0])
    expect(loaded.game.players[0].artUrl).toBe('https://x/a.jpg')
    expect(loaded.canAutoResume).toBe(true)
  })

  it('consumes the legacy key so it only migrates once', () => {
    sessionStorage.setItem(LEGACY_GAME_KEY, JSON.stringify(legacy))
    expect(loadGame()).not.toBeNull()
    expect(sessionStorage.getItem(LEGACY_GAME_KEY)).toBeNull()
    expect(loadGame()).toBeNull()
  })

  it('skips a legacy payload that was not mid-game', () => {
    sessionStorage.setItem(LEGACY_GAME_KEY, JSON.stringify({ ...legacy, screen: 'setup' }))
    expect(loadGame()).toBeNull()
  })

  it('prefers the current record over the legacy one', () => {
    sessionStorage.setItem(LEGACY_GAME_KEY, JSON.stringify(legacy))
    saveGame(createGame({ format: 'standard', seatCount: 2 }))
    expect(loadGame().game.players.map(p => p.life)).toEqual([20, 20])
  })

  it('survives unparseable legacy data', () => {
    sessionStorage.setItem(LEGACY_GAME_KEY, '{broken')
    expect(loadGame()).toBeNull()
  })
})

describe('registerFlushHooks', () => {
  it('flushes when the page is hidden', () => {
    const cleanup = registerFlushHooks()
    let game = createGame({ format: 'standard', seatCount: 2 })
    saveGame(game)
    game = gameReducer(game, { type: 'life', id: 0, delta: -6, ts: 1 })
    saveGame(game)

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(stored().game.players[0].life).toBe(14)
    cleanup()
  })

  it('does not flush while the page is still visible', () => {
    const cleanup = registerFlushHooks()
    let game = createGame({ format: 'standard', seatCount: 2 })
    saveGame(game)
    game = gameReducer(game, { type: 'life', id: 0, delta: -6, ts: 1 })
    saveGame(game)

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(stored().game.players[0].life).toBe(20)
    cleanup()
  })

  it('flushes on pagehide', () => {
    const cleanup = registerFlushHooks()
    let game = createGame({ format: 'standard', seatCount: 2 })
    saveGame(game)
    game = gameReducer(game, { type: 'life', id: 0, delta: -9, ts: 1 })
    saveGame(game)

    window.dispatchEvent(new Event('pagehide'))
    expect(stored().game.players[0].life).toBe(11)
    cleanup()
  })

  it('flushes on cleanup, so unmounting mid-game still persists', () => {
    const cleanup = registerFlushHooks()
    let game = createGame({ format: 'standard', seatCount: 2 })
    saveGame(game)
    game = gameReducer(game, { type: 'life', id: 0, delta: -2, ts: 1 })
    saveGame(game)
    cleanup()
    expect(stored().game.players[0].life).toBe(18)
  })
})

describe('storage failure', () => {
  it('keeps the game in memory when localStorage refuses writes', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)

    saveGame(gameReducer(createGame({ format: 'standard', seatCount: 2 }), { type: 'life', id: 0, delta: -3, ts: 1 }))
    const loaded = loadGame()
    expect(loaded.game.players[0].life).toBe(17)

    setItem.mockRestore()
    getItem.mockRestore()
  })
})

describe('setup preferences', () => {
  it('defaults to Commander for four', () => {
    expect(loadSetup()).toEqual({ format: 'commander', seatCount: 4, customLife: 20, layoutId: null })
  })

  it('round-trips, so leaving the page does not reset the choices', () => {
    saveSetup({ format: 'custom', seatCount: 5, customLife: 60, layoutId: '5-handheld' })
    expect(loadSetup()).toEqual({ format: 'custom', seatCount: 5, customLife: 60, layoutId: '5-handheld' })
  })

  it('falls back per-field on a partial or corrupt record', () => {
    localStorage.setItem(SETUP_KEY, JSON.stringify({ format: 'brawl', seatCount: 'x' }))
    expect(loadSetup()).toEqual({ format: 'brawl', seatCount: 4, customLife: 20, layoutId: null })
    localStorage.setItem(SETUP_KEY, 'not json')
    expect(loadSetup().format).toBe('commander')
  })
})
