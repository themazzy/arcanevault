import { describe, it, expect } from 'vitest'
import { generateJoinCode, mergeSlotAttribution, seedsFromSlots } from './lifeLobby'
import { createGame, gameReducer } from './lifeGame'

const slot = (index, over = {}) => ({
  id: `slot-${index}`,
  slot_index: index,
  player_name: `Player ${index + 1}`,
  color: '#d94f4f',
  user_id: null,
  deck_id: null,
  deck_name: null,
  art_crop_url: null,
  ...over,
})

describe('generateJoinCode', () => {
  it('is six characters with no glyphs that get misread aloud', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode()
      expect(code).toHaveLength(6)
      // No I, O, 0 or 1 — codes get read across a table.
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    }
  })
})

describe('seedsFromSlots', () => {
  it('carries identity, deck and the originating slot index', () => {
    const seeds = seedsFromSlots([
      slot(0, { player_name: 'Jan', user_id: 'u1', deck_id: 'd1', deck_name: 'Atraxa', art_crop_url: 'art' }),
      slot(1),
    ])
    expect(seeds[0]).toEqual({
      name: 'Jan', color: '#d94f4f', deckId: 'd1', deckName: 'Atraxa',
      artUrl: 'art', userId: 'u1', slotIndex: 0,
    })
    expect(seeds[1].userId).toBeNull()
  })

  it('keeps unclaimed seats — a four-seat lobby two people joined is still four players', () => {
    const game = createGame({ format: 'commander', seatCount: 4, seeds: seedsFromSlots([
      slot(0, { user_id: 'u1' }), slot(1, { user_id: 'u2' }), slot(2), slot(3),
    ]) })
    expect(game.players).toHaveLength(4)
    expect(game.players.map(p => p.userId)).toEqual(['u1', 'u2', null, null])
  })
})

describe('mergeSlotAttribution', () => {
  const buildShared = () => createGame({
    format: 'commander', seatCount: 4, sessionId: 'sess-1',
    seeds: seedsFromSlots([
      slot(0, { player_name: 'Jan', user_id: 'host', deck_id: 'd1', deck_name: 'Atraxa' }),
      slot(1, { player_name: 'Ada', user_id: 'ada', deck_id: 'd2', deck_name: 'Krenko' }),
      slot(2, { player_name: 'Lee' }),
      slot(3, { player_name: 'Sam' }),
    ]),
  })

  it('picks up a deck a guest changed after the game started', () => {
    const game = buildShared()
    const merged = mergeSlotAttribution(game, [
      slot(0, { user_id: 'host', deck_id: 'd1', deck_name: 'Atraxa' }),
      slot(1, { user_id: 'ada', deck_id: 'd9', deck_name: 'Ur-Dragon' }),
      slot(2), slot(3),
    ])
    expect(merged.players[1]).toMatchObject({ userId: 'ada', deckId: 'd9', deckName: 'Ur-Dragon' })
  })

  it('picks up a seat claimed after the game started', () => {
    const game = buildShared()
    const merged = mergeSlotAttribution(game, [
      slot(0, { user_id: 'host', deck_id: 'd1', deck_name: 'Atraxa' }),
      slot(1, { user_id: 'ada', deck_id: 'd2', deck_name: 'Krenko' }),
      slot(2, { user_id: 'lee', deck_id: 'd3', deck_name: 'Slivers' }),
      slot(3),
    ])
    expect(merged.players[2]).toMatchObject({ userId: 'lee', deckId: 'd3', deckName: 'Slivers' })
  })

  it('follows the player after seats are swapped, not the position', () => {
    // The scenario that makes this a contract rather than a convenience: swapping
    // chairs must not hand one player's win to another player's account.
    let game = buildShared()
    game = gameReducer(game, { type: 'swapSeats', a: 0, b: 3 })
    expect(game.players.map(p => p.name)).toEqual(['Sam', 'Ada', 'Lee', 'Jan'])

    const merged = mergeSlotAttribution(game, [
      slot(0, { user_id: 'host', deck_id: 'dX', deck_name: 'Host New Deck' }),
      slot(1, { user_id: 'ada', deck_id: 'd2', deck_name: 'Krenko' }),
      slot(2), slot(3),
    ])

    const jan = merged.players.find(p => p.name === 'Jan')
    const sam = merged.players.find(p => p.name === 'Sam')
    expect(jan).toMatchObject({ userId: 'host', deckId: 'dX', deckName: 'Host New Deck' })
    // Sam never claimed a seat, so nothing gets attached to them.
    expect(sam.userId).toBeNull()
    expect(sam.deckId).toBeNull()
  })

  it('leaves unclaimed seats to whatever the host set on the device', () => {
    let game = buildShared()
    game = gameReducer(game, {
      type: 'patchPlayer', id: 2, patch: { deckId: 'local', deckName: 'Host picked this' },
    })
    const merged = mergeSlotAttribution(game, [
      slot(0, { user_id: 'host' }), slot(1, { user_id: 'ada' }), slot(2), slot(3),
    ])
    expect(merged.players[2]).toMatchObject({ deckId: 'local', deckName: 'Host picked this', userId: null })
  })

  it('falls back to position for a game seeded before slotIndex existed', () => {
    const game = createGame({ format: 'commander', seatCount: 2, sessionId: 's' })
    // Simulate a restored older game: no slotIndex on the players.
    game.players = game.players.map(p => ({ ...p, slotIndex: null }))
    const merged = mergeSlotAttribution(game, [
      slot(0, { user_id: 'host', deck_id: 'd1', deck_name: 'Atraxa' }),
      slot(1, { user_id: 'ada', deck_id: 'd2', deck_name: 'Krenko' }),
    ])
    expect(merged.players.map(p => p.userId)).toEqual(['host', 'ada'])
  })

  it('returns the game untouched when there are no slots', () => {
    const game = buildShared()
    expect(mergeSlotAttribution(game, [])).toBe(game)
    expect(mergeSlotAttribution(game, null)).toBe(game)
  })
})
