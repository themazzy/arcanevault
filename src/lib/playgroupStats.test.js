import { describe, it, expect } from 'vitest'
import { computePlaygroupLeaderboard, computeOwnerStreaks } from './playgroupStats'

const game = (played_at, placement, players) => ({ played_at, placement, players_json: players })
const P = (name, placement, color) => ({ name, placement, color })

describe('computePlaygroupLeaderboard', () => {
  it('aggregates games and wins per player across standings', () => {
    const rows = [
      game('2026-06-01', 1, [P('Jan', 1, '#f00'), P('Ada', 2), P('Bo', 3)]),
      game('2026-06-02', 2, [P('Jan', 2), P('Ada', 1), P('Bo', 3)]),
      game('2026-06-03', 1, [P('Jan', 1), P('Bo', 2)]),
    ]
    const lb = computePlaygroupLeaderboard(rows)
    const jan = lb.find(r => r.name === 'Jan')
    const ada = lb.find(r => r.name === 'Ada')
    const bo = lb.find(r => r.name === 'Bo')
    expect(jan).toMatchObject({ games: 3, wins: 2 })
    expect(jan.winRate).toBeCloseTo(66.67, 1)
    expect(ada).toMatchObject({ games: 2, wins: 1 })
    expect(bo).toMatchObject({ games: 3, wins: 0 })
  })

  it('sorts by win rate then games, and keeps a color', () => {
    const rows = [
      game('2026-06-01', 1, [P('Win', 1, '#0f0'), P('Mid', 2)]),
      game('2026-06-02', 1, [P('Win', 1), P('Mid', 2)]),
    ]
    const lb = computePlaygroupLeaderboard(rows)
    expect(lb[0].name).toBe('Win')
    expect(lb[0].color).toBe('#0f0')
    expect(lb[0].winRate).toBe(100)
  })

  it('ignores duplicate names within a single game and empty standings', () => {
    const rows = [
      game('2026-06-01', 1, [P('Jan', 1), P('Jan', 2)]),
      game('2026-06-02', 1, []),
    ]
    const lb = computePlaygroupLeaderboard(rows)
    expect(lb).toHaveLength(1)
    expect(lb[0]).toMatchObject({ name: 'Jan', games: 1, wins: 1 })
  })

  it('returns empty for no rows', () => {
    expect(computePlaygroupLeaderboard([])).toEqual([])
  })
})

describe('computeOwnerStreaks', () => {
  it('computes current trailing streak and longest streak by date', () => {
    const rows = [
      game('2026-06-01', 1, []),
      game('2026-06-02', 1, []),
      game('2026-06-03', 2, []), // breaks
      game('2026-06-04', 1, []),
      game('2026-06-05', 1, []),
    ]
    const s = computeOwnerStreaks(rows)
    expect(s.current).toBe(2)   // last two are wins
    expect(s.longest).toBe(2)
    expect(s.lastResult).toBe('win')
  })

  it('current is 0 when the latest game is a loss', () => {
    const rows = [game('2026-06-01', 1, []), game('2026-06-02', 3, [])]
    const s = computeOwnerStreaks(rows)
    expect(s.current).toBe(0)
    expect(s.lastResult).toBe('loss')
  })

  it('handles unordered input and missing placements', () => {
    const rows = [
      game('2026-06-03', 1, []),
      game('2026-06-01', 1, []),
      { played_at: '2026-06-02', placement: null, players_json: [] }, // skipped
    ]
    const s = computeOwnerStreaks(rows)
    expect(s.longest).toBe(2)
    expect(s.current).toBe(2)
  })

  it('returns zeros for no rows', () => {
    expect(computeOwnerStreaks([])).toEqual({ current: 0, longest: 0, lastResult: null })
  })
})
