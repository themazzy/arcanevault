import { describe, it, expect } from 'vitest'
import {
  createGame, gameReducer, isPlayerDead, maxCmdDmg, migrateGame, deathTextFor,
  findLayout, layoutsFor, clampSeats, clampLife, startingLifeFor,
  LOG_MERGE_MS, MAX_LOG, PLAYER_COLORS, GAME_VERSION, DEATH_TEXTS,
} from './lifeGame'

const game = (over = {}) => createGame({ format: 'commander', seatCount: 4, ...over })
const seat = (state, id) => state.players.find(p => p.id === id)

describe('createGame', () => {
  it('seats the format default life', () => {
    expect(game().players.every(p => p.life === 40)).toBe(true)
    expect(createGame({ format: 'standard' }).startingLife).toBe(20)
    expect(createGame({ format: 'brawl' }).startingLife).toBe(25)
  })

  it('honours custom life only for the custom format', () => {
    expect(createGame({ format: 'custom', customLife: 77 }).startingLife).toBe(77)
    expect(createGame({ format: 'commander', customLife: 77 }).startingLife).toBe(40)
  })

  it('clamps seat count into range and picks a matching layout', () => {
    expect(createGame({ seatCount: 99 }).seatCount).toBe(6)
    expect(createGame({ seatCount: 0 }).seatCount).toBe(2)
    const g = createGame({ seatCount: 3 })
    expect(layoutsFor(3).some(l => l.id === g.layoutId)).toBe(true)
  })

  it('gives every seat a distinct color', () => {
    const colors = createGame({ seatCount: 6 }).players.map(p => p.color)
    expect(new Set(colors).size).toBe(6)
    expect(colors[0]).toBe(PLAYER_COLORS[0])
  })
})

describe('clamps', () => {
  it('clampLife keeps 1..999 and survives junk', () => {
    expect(clampLife(0)).toBe(1)
    expect(clampLife(9999)).toBe(999)
    expect(clampLife('')).toBe(1)
    expect(clampLife(NaN)).toBe(1)
    expect(clampLife('25')).toBe(25)
  })
  it('clampSeats keeps 2..6', () => {
    expect(clampSeats(1)).toBe(2)
    expect(clampSeats(7)).toBe(6)
    expect(clampSeats('4')).toBe(4)
  })
  it('startingLifeFor falls back for unknown formats', () => {
    expect(startingLifeFor('nonsense')).toBe(20)
  })
})

describe('life', () => {
  it('applies a delta and logs it', () => {
    const next = gameReducer(game(), { type: 'life', id: 0, delta: -3, ts: 1000 })
    expect(seat(next, 0).life).toBe(37)
    expect(next.log[0]).toMatchObject({ kind: 'life', playerId: 0, delta: -3, total: 37 })
  })

  it('goes negative rather than clamping at zero', () => {
    let s = game()
    s = gameReducer(s, { type: 'life', id: 0, delta: -45, ts: 1000 })
    expect(seat(s, 0).life).toBe(-5)
  })

  it('ignores a stale seat id instead of throwing', () => {
    const s = game()
    expect(gameReducer(s, { type: 'life', id: 99, delta: -1 })).toBe(s)
  })

  it('leaves other seats untouched', () => {
    const next = gameReducer(game(), { type: 'life', id: 1, delta: -10, ts: 1 })
    expect(next.players.map(p => p.life)).toEqual([40, 30, 40, 40])
  })
})

describe('log merging', () => {
  it('merges rapid taps on the same seat into one entry', () => {
    let s = game()
    for (let i = 0; i < 5; i++) {
      s = gameReducer(s, { type: 'life', id: 0, delta: -1, ts: 1000 + i * 100 })
    }
    expect(s.log).toHaveLength(1)
    expect(s.log[0]).toMatchObject({ delta: -5, total: 35 })
  })

  it('starts a new entry once the merge window lapses', () => {
    let s = game()
    s = gameReducer(s, { type: 'life', id: 0, delta: -1, ts: 1000 })
    s = gameReducer(s, { type: 'life', id: 0, delta: -1, ts: 1000 + LOG_MERGE_MS + 1 })
    expect(s.log).toHaveLength(2)
  })

  it('does not merge across seats', () => {
    let s = game()
    s = gameReducer(s, { type: 'life', id: 0, delta: -1, ts: 1000 })
    s = gameReducer(s, { type: 'life', id: 1, delta: -1, ts: 1050 })
    expect(s.log).toHaveLength(2)
  })

  it('drops an entry that nets back to zero', () => {
    let s = game()
    s = gameReducer(s, { type: 'life', id: 0, delta: -3, ts: 1000 })
    s = gameReducer(s, { type: 'life', id: 0, delta: 3, ts: 1100 })
    expect(s.log).toHaveLength(0)
    expect(seat(s, 0).life).toBe(40)
  })

  it('caps the log length', () => {
    let s = game()
    for (let i = 0; i < MAX_LOG + 25; i++) {
      s = gameReducer(s, { type: 'life', id: 0, delta: -1, ts: i * (LOG_MERGE_MS + 1) })
    }
    expect(s.log).toHaveLength(MAX_LOG)
  })
})

describe('commander damage', () => {
  it('moves life and damage together', () => {
    const next = gameReducer(game(), { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: 5, ts: 1 })
    expect(seat(next, 0).dmg[1]).toEqual([5, 0])
    expect(seat(next, 0).life).toBe(35)
  })

  it('tracks a partner separately in slot 1', () => {
    let s = game()
    s = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: 6, ts: 1 })
    s = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 1, delta: 4, ts: 2 })
    expect(seat(s, 0).dmg[1]).toEqual([6, 4])
    expect(seat(s, 0).life).toBe(30)
  })

  it('never goes below zero, and refunds only what it removed', () => {
    let s = game()
    s = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: 3, ts: 1 })
    s = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: -10, ts: 2 })
    expect(seat(s, 0).dmg[1]).toBeUndefined()
    expect(seat(s, 0).life).toBe(40)
  })

  it('is a no-op at zero rather than logging an empty event', () => {
    const s = game()
    const next = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: -1 })
    expect(next).toBe(s)
  })

  it('names the source in the log', () => {
    let s = gameReducer(game(), { type: 'patchPlayer', id: 1, patch: { name: 'Atraxa' } })
    s = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: 7, ts: 1 })
    expect(s.log[0]).toMatchObject({ kind: 'cmdDamage', fromName: 'Atraxa', delta: -7 })
  })
})

describe('counters', () => {
  it('increments and floors at zero', () => {
    let s = gameReducer(game(), { type: 'counter', id: 0, key: 'poison', delta: 3, ts: 1 })
    expect(seat(s, 0).counters.poison).toBe(3)
    s = gameReducer(s, { type: 'counter', id: 0, key: 'poison', delta: -9, ts: 2 })
    expect(seat(s, 0).counters.poison).toBe(0)
  })

  it('is a no-op when already zero', () => {
    const s = game()
    expect(gameReducer(s, { type: 'counter', id: 0, key: 'energy', delta: -1 })).toBe(s)
  })
})

describe('commander tax', () => {
  it('tracks both commanders and floors at zero', () => {
    let s = gameReducer(game(), { type: 'tax', id: 0, slot: 0, delta: 2 })
    s = gameReducer(s, { type: 'tax', id: 0, slot: 1, delta: 1 })
    expect(seat(s, 0).tax).toEqual([2, 1])
    s = gameReducer(s, { type: 'tax', id: 0, slot: 0, delta: -5 })
    expect(seat(s, 0).tax).toEqual([0, 1])
  })

  it('stays out of the log — it is not a life event', () => {
    const s = gameReducer(game(), { type: 'tax', id: 0, slot: 0, delta: 2 })
    expect(s.log).toHaveLength(0)
  })
})

describe('patchPlayer', () => {
  it('trims and caps the name', () => {
    const s = gameReducer(game(), { type: 'patchPlayer', id: 0, patch: { name: '  Jan  ' } })
    expect(seat(s, 0).name).toBe('Jan')
    const long = gameReducer(game(), { type: 'patchPlayer', id: 0, patch: { name: 'x'.repeat(50) } })
    expect(seat(long, 0).name).toHaveLength(24)
  })

  it('keeps the old name when the field is emptied', () => {
    const s = gameReducer(game(), { type: 'patchPlayer', id: 0, patch: { name: '   ' } })
    expect(seat(s, 0).name).toBe('Player 1')
  })

  it('sets art, deck and partner without logging', () => {
    const s = gameReducer(game(), {
      type: 'patchPlayer', id: 0,
      patch: { artUrl: 'https://x/art.jpg', deckId: 'd1', deckName: 'Atraxa', hasPartner: true },
    })
    expect(seat(s, 0)).toMatchObject({ artUrl: 'https://x/art.jpg', deckId: 'd1', deckName: 'Atraxa', hasPartner: true })
    expect(s.log).toHaveLength(0)
  })
})

describe('swapSeats', () => {
  it('swaps positions in the array', () => {
    const s = gameReducer(game(), { type: 'swapSeats', a: 0, b: 2 })
    expect(s.players.map(p => p.id)).toEqual([2, 1, 0, 3])
  })

  it('keeps ids attached to their player, so damage and logs still resolve', () => {
    let s = game()
    s = gameReducer(s, { type: 'patchPlayer', id: 0, patch: { name: 'Jan', deckName: 'Atraxa' } })
    s = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: 9, ts: 1 })
    s = gameReducer(s, { type: 'counter', id: 0, key: 'poison', delta: 3, ts: 2 })

    s = gameReducer(s, { type: 'swapSeats', a: 0, b: 3 })

    // Jan moved to the last position but carries everything with him.
    const jan = s.players[3]
    expect(jan).toMatchObject({ id: 0, name: 'Jan', deckName: 'Atraxa', life: 31 })
    expect(jan.dmg[1]).toEqual([9, 0])
    expect(jan.counters.poison).toBe(3)
    // ...and damage still keys off the dealing player's id, not their position.
    expect(seat(s, 0).dmg[1]).toEqual([9, 0])
  })

  it('leaves the log untouched — moving chairs is not a game event', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -4, ts: 1 })
    const before = s.log
    s = gameReducer(s, { type: 'swapSeats', a: 0, b: 1 })
    expect(s.log).toBe(before)
  })

  it('does not invent a death when players move', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -40, ts: 1 })
    expect(seat(s, 0).deaths).toBe(1)
    s = gameReducer(s, { type: 'swapSeats', a: 0, b: 2 })
    expect(seat(s, 0).deaths).toBe(1)
  })

  it('is a no-op for the same seat or an index that does not exist', () => {
    const s = game()
    expect(gameReducer(s, { type: 'swapSeats', a: 1, b: 1 })).toBe(s)
    expect(gameReducer(s, { type: 'swapSeats', a: 0, b: 9 })).toBe(s)
    expect(gameReducer(s, { type: 'swapSeats', a: -1, b: 0 })).toBe(s)
  })

  it('survives a save/load round trip in the new order', () => {
    let s = gameReducer(game(), { type: 'swapSeats', a: 0, b: 1 })
    const loaded = migrateGame(JSON.parse(JSON.stringify(s)))
    expect(loaded.players.map(p => p.id)).toEqual([1, 0, 2, 3])
  })

  it('two swaps back return the original order', () => {
    let s = gameReducer(game(), { type: 'swapSeats', a: 0, b: 3 })
    s = gameReducer(s, { type: 'swapSeats', a: 0, b: 3 })
    expect(s.players.map(p => p.id)).toEqual([0, 1, 2, 3])
  })
})

describe('reset', () => {
  it('clears counters, damage and tax — the old reset left poison behind', () => {
    let s = game()
    s = gameReducer(s, { type: 'counter', id: 0, key: 'poison', delta: 10, ts: 1 })
    s = gameReducer(s, { type: 'cmdDamage', id: 0, fromId: 1, slot: 0, delta: 21, ts: 2 })
    s = gameReducer(s, { type: 'tax', id: 0, slot: 0, delta: 4 })
    expect(isPlayerDead(seat(s, 0))).toBe(true)

    s = gameReducer(s, { type: 'reset', ts: 3 })
    expect(seat(s, 0)).toMatchObject({ life: 40, counters: { poison: 0, energy: 0, experience: 0 }, tax: [0, 0] })
    expect(seat(s, 0).dmg).toEqual({})
    expect(isPlayerDead(seat(s, 0))).toBe(false)
    expect(s.log).toHaveLength(0)
  })

  it('keeps identities and decks', () => {
    let s = gameReducer(game(), {
      type: 'patchPlayer', id: 0,
      patch: { name: 'Jan', deckId: 'd1', deckName: 'Atraxa', artUrl: 'u', hasPartner: true },
    })
    s = gameReducer(s, { type: 'reset', ts: 1 })
    expect(seat(s, 0)).toMatchObject({ name: 'Jan', deckId: 'd1', deckName: 'Atraxa', artUrl: 'u', hasPartner: true })
  })
})

describe('isPlayerDead', () => {
  const p = (over = {}) => ({ life: 40, counters: { poison: 0 }, dmg: {}, ...over })

  it('is alive at positive life with nothing lethal', () => {
    expect(isPlayerDead(p())).toBe(false)
  })
  it('dies at 0 or less life', () => {
    expect(isPlayerDead(p({ life: 0 }))).toBe(true)
    expect(isPlayerDead(p({ life: -7 }))).toBe(true)
  })
  it('dies at 10 poison, not 9', () => {
    expect(isPlayerDead(p({ counters: { poison: 9 } }))).toBe(false)
    expect(isPlayerDead(p({ counters: { poison: 10 } }))).toBe(true)
  })
  it('dies at 21 from one commander, including a partner', () => {
    expect(isPlayerDead(p({ dmg: { 1: [21, 0] } }))).toBe(true)
    expect(isPlayerDead(p({ dmg: { 1: [0, 22] } }))).toBe(true)
  })
  it('survives 20 + 20 from two different commanders', () => {
    expect(isPlayerDead(p({ dmg: { 1: [20, 0], 2: [20, 0] } }))).toBe(false)
  })
  it('survives 20 + 20 from a commander and its own partner', () => {
    expect(isPlayerDead(p({ dmg: { 1: [20, 20] } }))).toBe(false)
  })
  it('tolerates missing fields and null', () => {
    expect(isPlayerDead(null)).toBe(false)
    expect(isPlayerDead({ life: 40 })).toBe(false)
  })
})

describe('death flavour', () => {
  it('offers 40 distinct, non-empty lines', () => {
    expect(DEATH_TEXTS).toHaveLength(40)
    expect(new Set(DEATH_TEXTS).size).toBe(40)
    expect(DEATH_TEXTS.every(t => typeof t === 'string' && t.trim().length > 0)).toBe(true)
  })

  it('keeps every line short enough to read on a phone panel', () => {
    // Two clamped lines at the smallest panel size; much beyond this is truncated.
    expect(DEATH_TEXTS.every(t => t.length <= 40)).toBe(true)
  })

  it('says nothing while a player is alive', () => {
    const s = game()
    expect(deathTextFor(s, seat(s, 0))).toBeNull()
  })

  it('gives a dead player one of the lines', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -40, ts: 1 })
    expect(DEATH_TEXTS).toContain(deathTextFor(s, seat(s, 0)))
  })

  it('is stable across repeated reads — it must not re-roll on every render', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -40, ts: 1 })
    const first = deathTextFor(s, seat(s, 0))
    for (let i = 0; i < 25; i++) expect(deathTextFor(s, seat(s, 0))).toBe(first)
  })

  it('survives a save/load round trip', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -40, ts: 1 })
    const before = deathTextFor(s, seat(s, 0))
    const loaded = migrateGame(JSON.parse(JSON.stringify(s)))
    expect(deathTextFor(loaded, loaded.players[0])).toBe(before)
  })

  it('does not change as a dead player takes further damage', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -40, ts: 1 })
    const first = deathTextFor(s, seat(s, 0))
    s = gameReducer(s, { type: 'life', id: 0, delta: -3, ts: 5000 })
    expect(seat(s, 0).deaths).toBe(1)
    expect(deathTextFor(s, seat(s, 0))).toBe(first)
  })

  it('counts a death once per crossing, not once per action', () => {
    let s = game()
    expect(seat(s, 0).deaths).toBe(0)
    s = gameReducer(s, { type: 'life', id: 0, delta: -40, ts: 1 })
    expect(seat(s, 0).deaths).toBe(1)
    s = gameReducer(s, { type: 'life', id: 0, delta: -1, ts: 2 })
    s = gameReducer(s, { type: 'counter', id: 0, key: 'energy', delta: 1, ts: 3 })
    expect(seat(s, 0).deaths).toBe(1)
  })

  it('re-rolls when a player is brought back and killed again', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -40, ts: 1 })
    s = gameReducer(s, { type: 'life', id: 0, delta: 40, ts: 5000 })   // revived
    expect(deathTextFor(s, seat(s, 0))).toBeNull()
    s = gameReducer(s, { type: 'life', id: 0, delta: -40, ts: 9000 })  // dead again
    expect(seat(s, 0).deaths).toBe(2)
    expect(DEATH_TEXTS).toContain(deathTextFor(s, seat(s, 0)))
  })

  it('picks a different line for at least some repeat deaths', () => {
    const s = game()
    const seen = new Set(
      Array.from({ length: 10 }, (_, deaths) =>
        deathTextFor(s, { ...seat(s, 0), life: 0, deaths })),
    )
    expect(seen.size).toBeGreaterThan(1)
  })

  it('spreads across the whole list rather than favouring one line', () => {
    const seen = new Set()
    for (let startedAt = 0; startedAt < 400; startedAt++) {
      for (let id = 0; id < 6; id++) {
        seen.add(deathTextFor({ startedAt }, { id, life: 0, deaths: 0 }))
      }
    }
    expect(seen.size).toBeGreaterThan(30)
  })

  it('counts poison and commander damage deaths too', () => {
    let s = gameReducer(game(), { type: 'counter', id: 0, key: 'poison', delta: 10, ts: 1 })
    expect(seat(s, 0).deaths).toBe(1)
    expect(DEATH_TEXTS).toContain(deathTextFor(s, seat(s, 0)))

    let t = gameReducer(game(), { type: 'cmdDamage', id: 1, fromId: 0, slot: 0, delta: 21, ts: 1 })
    expect(seat(t, 1).deaths).toBe(1)
  })

  it('clears death counts on reset, so a fresh game reads fresh', () => {
    let s = gameReducer(game(), { type: 'life', id: 0, delta: -40, ts: 1 })
    s = gameReducer(s, { type: 'reset', ts: 2 })
    expect(seat(s, 0).deaths).toBe(0)
    expect(deathTextFor(s, seat(s, 0))).toBeNull()
  })
})

describe('maxCmdDmg', () => {
  it('reports the single highest commander, not the sum', () => {
    expect(maxCmdDmg({ dmg: { 1: [12, 3], 2: [8, 0] } })).toBe(12)
    expect(maxCmdDmg({ dmg: {} })).toBe(0)
    expect(maxCmdDmg({})).toBe(0)
  })
})

describe('layouts', () => {
  it('gives every seat an area and rotation for every count', () => {
    for (let n = 2; n <= 6; n++) {
      for (const layout of layoutsFor(n)) {
        expect(layout.seats).toHaveLength(n)
        for (const s of layout.seats) {
          expect(typeof s.area).toBe('string')
          expect([0, 90, -90, 180]).toContain(s.rotation)
        }
      }
    }
  })

  it('offers a rotated table layout and an all-upright handheld layout per count', () => {
    for (let n = 2; n <= 6; n++) {
      const options = layoutsFor(n)
      expect(options.some(l => l.kind === 'table' && l.seats.some(s => s.rotation !== 0))).toBe(true)
      const handheld = options.find(l => l.kind === 'handheld')
      expect(handheld.seats.every(s => s.rotation === 0)).toBe(true)
    }
  })

  it('only references areas that the template declares', () => {
    for (let n = 2; n <= 6; n++) {
      for (const layout of layoutsFor(n)) {
        const declared = new Set(layout.areas.match(/[a-z]+/g))
        for (const s of layout.seats) expect(declared.has(s.area)).toBe(true)
      }
    }
  })

  it('falls back to the first option for an unknown layout id', () => {
    expect(findLayout(4, 'nope').id).toBe(layoutsFor(4)[0].id)
  })
})

describe('migrateGame', () => {
  it('round-trips a current game', () => {
    let s = game()
    s = gameReducer(s, { type: 'life', id: 0, delta: -5, ts: 1 })
    const back = migrateGame(JSON.parse(JSON.stringify(s)))
    expect(back.players.map(p => p.life)).toEqual([35, 40, 40, 40])
    expect(back.log).toHaveLength(1)
  })

  it('converts the pre-rewrite sessionStorage payload, including partner damage', () => {
    const legacy = {
      screen: 'playing',
      startedAt: 1700000000000,
      config: { mode: 'commander', playerCount: 3, layout: { rotations: { 0: 180, 1: 180 } } },
      players: [
        { id: 0, name: 'Jan', color: '#c46060', life: 22, artCropUrl: 'https://x/a.jpg',
          deckId: 'd1', deckName: 'Atraxa', cmdTax: 4, cmdTax2: 2,
          cmdDmg: { 1: 12 }, cmdDmg2: { 1: 6 }, counters: { poison: 3, energy: 0, experience: 1 } },
        { id: 1, name: 'Ada', color: '#6080c4', life: 40, hasPartner: true },
        { id: 2, name: 'Lee', color: '#60a860', life: 31 },
      ],
    }
    const g = migrateGame(legacy)
    expect(g.version).toBe(GAME_VERSION)
    expect(g.format).toBe('commander')
    expect(g.seatCount).toBe(3)
    expect(g.startedAt).toBe(1700000000000)
    expect(g.players.map(p => p.life)).toEqual([22, 40, 31])
    expect(g.players[0]).toMatchObject({
      name: 'Jan', artUrl: 'https://x/a.jpg', deckName: 'Atraxa', tax: [4, 2],
      counters: { poison: 3, energy: 0, experience: 1 },
    })
    expect(g.players[0].dmg[1]).toEqual([12, 6])
    expect(g.players[1].hasPartner).toBe(true)
    // rotations present in the old layout ⇒ a table layout
    expect(findLayout(3, g.layoutId).kind).toBe('table')
  })

  it('reads a legacy custom-life game off the stored life value', () => {
    const g = migrateGame({
      screen: 'playing',
      config: { mode: 'custom', playerCount: 2, customLife: 60 },
      players: [{ id: 0, life: 55 }, { id: 1, life: 60 }],
    })
    expect(g.format).toBe('custom')
    expect(g.startingLife).toBe(60)
    expect(g.players.map(p => p.life)).toEqual([55, 60])
  })

  it('maps an unrecognised legacy mode to custom rather than dropping the game', () => {
    const g = migrateGame({
      screen: 'playing',
      config: { mode: 'twoHeadedGiant', playerCount: 2 },
      players: [{ id: 0, life: 30 }, { id: 1, life: 30 }],
    })
    expect(g.format).toBe('custom')
    expect(g.players.map(p => p.life)).toEqual([30, 30])
  })

  it('rejects junk', () => {
    expect(migrateGame(null)).toBeNull()
    expect(migrateGame('nope')).toBeNull()
    expect(migrateGame({})).toBeNull()
    expect(migrateGame({ players: [] })).toBeNull()
  })
})
