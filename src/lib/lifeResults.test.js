import { describe, it, expect } from 'vitest'
import {
  buildPlacements, serializeGamePlayers, selectResultPlayers,
  buildTrackedGamePayload, buildGameResultRows, buildDeckStatsMap,
} from './lifeResults'

const HOST = 'user-host'
const ENDED = 1700000600000

const mkGame = (over = {}) => ({
  format: 'commander',
  startingLife: 40,
  startedAt: 1700000000000,
  sessionId: null,
  players: [
    { id: 0, name: 'Jan', color: '#d94f4f', deckId: 'd1', deckName: 'Atraxa', userId: HOST, life: 12 },
    { id: 1, name: 'Ada', color: '#3d8fd9', deckId: 'd2', deckName: 'Krenko', userId: 'user-ada', life: 0 },
    { id: 2, name: 'Lee', color: '#4fae63', deckId: null, deckName: null, userId: null, life: -3 },
  ],
  ...over,
})

describe('buildPlacements', () => {
  it('assigns places in tap order', () => {
    const g = mkGame()
    expect(buildPlacements(g.players, [1, 0])).toEqual({ 1: 1, 0: 2, 2: 3 })
  })

  it('gives every untapped seat the same next place', () => {
    const g = mkGame()
    expect(buildPlacements(g.players, [2])).toEqual({ 2: 1, 0: 2, 1: 2 })
  })

  it('ignores duplicates and unknown ids', () => {
    const g = mkGame()
    expect(buildPlacements(g.players, [0, 0, 99, 1])).toEqual({ 0: 1, 1: 2, 2: 3 })
  })

  it('places everyone equal first when nothing was tapped', () => {
    const g = mkGame()
    expect(buildPlacements(g.players, [])).toEqual({ 0: 1, 1: 1, 2: 1 })
  })
})

describe('serializeGamePlayers — the players_json contract', () => {
  it('is an array carrying name, color, deckName and placement', () => {
    const g = mkGame()
    const json = serializeGamePlayers(g.players, buildPlacements(g.players, [0]))
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(3)
    for (const entry of json) {
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('color')
      expect(entry).toHaveProperty('deckName')
      expect(typeof entry.placement).toBe('number')
    }
    expect(json[0]).toMatchObject({ name: 'Jan', color: '#d94f4f', deckName: 'Atraxa', placement: 1, finalLife: 12 })
  })

  it('survives JSON round-tripping to the shape playgroupStats reads', () => {
    const g = mkGame()
    const json = JSON.parse(JSON.stringify(serializeGamePlayers(g.players, buildPlacements(g.players, [1]))))
    const winners = json.filter(p => p.placement === 1)
    expect(winners).toHaveLength(1)
    expect(winners[0].name).toBe('Ada')
  })
})

describe('selectResultPlayers', () => {
  it('shared game: every claimed seat, so guests get their own row', () => {
    const g = mkGame({ sessionId: 'sess-1' })
    expect(selectResultPlayers(g.players, { isShared: true }).map(p => p.id)).toEqual([0, 1])
  })

  it('local game: only seats with a deck', () => {
    const g = mkGame()
    expect(selectResultPlayers(g.players, { isShared: false }).map(p => p.id)).toEqual([0, 1])
  })

  it('local game with no decks at all: falls back to the first seat', () => {
    const g = mkGame({
      players: [
        { id: 0, name: 'Jan', deckId: null, deckName: null, life: 3 },
        { id: 1, name: 'Ada', deckId: null, deckName: 'No deck selected', life: 0 },
      ],
    })
    expect(selectResultPlayers(g.players, { isShared: false }).map(p => p.id)).toEqual([0])
  })

  it('treats the "No deck selected" placeholder as no deck', () => {
    const g = mkGame({
      players: [
        { id: 0, deckId: null, deckName: 'No deck selected' },
        { id: 1, deckId: 'd9', deckName: 'Real Deck' },
      ],
    })
    expect(selectResultPlayers(g.players, { isShared: false }).map(p => p.id)).toEqual([1])
  })
})

describe('buildTrackedGamePayload', () => {
  it('carries the columns tracked_games requires', () => {
    const g = mkGame()
    const payload = buildTrackedGamePayload({
      game: g, placements: buildPlacements(g.players, [0]), hostUserId: HOST, endedAt: ENDED,
    })
    expect(payload).toMatchObject({
      source_session_id: null, host_user_id: HOST, mode: 'commander',
      custom_life: null, player_count: 3, is_shared: false,
    })
    expect(payload.started_at).toBe('2023-11-14T22:13:20.000Z')
    expect(payload.ended_at).toBe(new Date(ENDED).toISOString())
    expect(Array.isArray(payload.players_json)).toBe(true)
  })

  it('marks shared games and records custom life only for the custom format', () => {
    const shared = buildTrackedGamePayload({
      game: mkGame({ sessionId: 'sess-1' }), placements: {}, hostUserId: HOST, endedAt: ENDED,
    })
    expect(shared).toMatchObject({ is_shared: true, source_session_id: 'sess-1' })

    const custom = buildTrackedGamePayload({
      game: mkGame({ format: 'custom', startingLife: 60 }), placements: {}, hostUserId: HOST, endedAt: ENDED,
    })
    expect(custom.custom_life).toBe(60)
  })

  it('falls back to endedAt when the start time is missing', () => {
    const payload = buildTrackedGamePayload({
      game: mkGame({ startedAt: null }), placements: {}, hostUserId: HOST, endedAt: ENDED,
    })
    expect(payload.started_at).toBe(new Date(ENDED).toISOString())
  })
})

describe('buildGameResultRows — the game_results contract', () => {
  it('local game: one row per decked seat, all owned by the host', () => {
    const g = mkGame()
    const rows = buildGameResultRows({
      game: g, placements: buildPlacements(g.players, [0]),
      hostUserId: HOST, endedAt: ENDED, notes: '  close one  ', trackedGameId: 42,
    })
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.user_id === HOST)).toBe(true)
    expect(rows.every(r => r.game_id === 42)).toBe(true)
    expect(rows[0]).toMatchObject({
      deck_id: 'd1', deck_name: 'Atraxa', format: 'commander', player_count: 3,
      placement: 1, player_name: 'Jan', player_color: '#d94f4f', final_life: 12,
      session_id: null, notes: 'close one',
    })
    expect(rows[0].played_at).toBe(new Date(ENDED).toISOString())
  })

  it('placement 1 marks exactly the winner — the invariant DeckWinrateMini reads', () => {
    const g = mkGame()
    const rows = buildGameResultRows({
      game: g, placements: buildPlacements(g.players, [1]), hostUserId: HOST, endedAt: ENDED,
    })
    const winners = rows.filter(r => r.placement === 1)
    expect(winners).toHaveLength(1)
    expect(winners[0].deck_id).toBe('d2')
  })

  it('shared game: rows are attributed to each guest account', () => {
    const g = mkGame({ sessionId: 'sess-1' })
    const rows = buildGameResultRows({
      game: g, placements: buildPlacements(g.players, [1]),
      hostUserId: HOST, endedAt: ENDED, notes: 'host note',
    })
    expect(rows.map(r => r.user_id)).toEqual([HOST, 'user-ada'])
    expect(rows.every(r => r.session_id === 'sess-1')).toBe(true)
  })

  it("shared game: the host's note never lands on a guest's record", () => {
    const g = mkGame({ sessionId: 'sess-1' })
    const rows = buildGameResultRows({
      game: g, placements: {}, hostUserId: HOST, endedAt: ENDED, notes: 'my thoughts',
    })
    expect(rows.find(r => r.user_id === HOST).notes).toBe('my thoughts')
    expect(rows.find(r => r.user_id === 'user-ada').notes).toBe('')
  })

  it('every row carries the full players_json so any one row rebuilds the table', () => {
    const g = mkGame()
    const rows = buildGameResultRows({
      game: g, placements: buildPlacements(g.players, [0]), hostUserId: HOST, endedAt: ENDED,
    })
    for (const row of rows) {
      expect(row.players_json).toHaveLength(3)
      expect(row.players_json.map(p => p.name)).toEqual(['Jan', 'Ada', 'Lee'])
    }
  })

  it('substitutes the placeholder deck name rather than writing null', () => {
    const g = mkGame({
      sessionId: 'sess-1',
      players: [{ id: 0, name: 'Jan', color: '#d94f4f', deckId: null, deckName: null, userId: HOST, life: 1 }],
    })
    const rows = buildGameResultRows({ game: g, placements: { 0: 1 }, hostUserId: HOST, endedAt: ENDED })
    expect(rows[0].deck_name).toBe('No deck selected')
    expect(rows[0].deck_id).toBeNull()
  })

  it('omits game_id when there is no tracked game yet', () => {
    const g = mkGame()
    const rows = buildGameResultRows({ game: g, placements: {}, hostUserId: HOST, endedAt: ENDED })
    expect('game_id' in rows[0]).toBe(false)
  })
})

describe('buildDeckStatsMap', () => {
  it('counts wins on placement 1 and losses on everything else', () => {
    const map = buildDeckStatsMap([
      { deck_id: 'd1', placement: 1 },
      { deck_id: 'd1', placement: 3 },
      { deck_id: 'd1', placement: 2 },
      { deck_id: 'd2', placement: 1 },
    ])
    expect(map.d1).toMatchObject({ wins: 1, losses: 2, games: 3, win_pct: 33 })
    expect(map.d2).toMatchObject({ wins: 1, losses: 0, games: 1, win_pct: 100 })
  })

  it('treats a stringified placement as a win', () => {
    expect(buildDeckStatsMap([{ deck_id: 'd1', placement: '1' }]).d1.wins).toBe(1)
  })

  it('skips rows with no deck and tolerates junk input', () => {
    expect(buildDeckStatsMap([{ deck_id: null, placement: 1 }])).toEqual({})
    expect(buildDeckStatsMap(null)).toEqual({})
  })
})
