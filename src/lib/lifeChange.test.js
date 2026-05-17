import { describe, it, expect } from 'vitest'
import { buildLifeChange } from './lifeChange'

const PLAYERS = [
  { id: 'p1', name: 'Alice', color: '#c46060', life: 40 },
  { id: 'p2', name: 'Bob',   color: '#6080c4', life: 35 },
]

describe('buildLifeChange', () => {
  it('returns null when the player id is not in the list (the stale-id guard)', () => {
    expect(buildLifeChange(PLAYERS, 'unknown', -1)).toBeNull()
    expect(buildLifeChange(PLAYERS, undefined, +1)).toBeNull()
  })

  it('returns null when players is empty / null / undefined', () => {
    expect(buildLifeChange([], 'p1', -1)).toBeNull()
    expect(buildLifeChange(null, 'p1', -1)).toBeNull()
    expect(buildLifeChange(undefined, 'p1', -1)).toBeNull()
  })

  it('computes the resolved life from the current player.life + delta', () => {
    expect(buildLifeChange(PLAYERS, 'p1', -3).nextLife).toBe(37)
    expect(buildLifeChange(PLAYERS, 'p2', +5).nextLife).toBe(40)
  })

  it('builds a log entry carrying delta, total, name, and color from the matched player', () => {
    const r = buildLifeChange(PLAYERS, 'p1', -2)
    expect(r.logEntry).toEqual({
      type: 'life',
      delta: -2,
      total: 38,
      playerName: 'Alice',
      playerColor: '#c46060',
    })
  })

  it('does NOT produce NaN under any input — the bug this guard exists to prevent', () => {
    // Stale id used to yield (undefined ?? 0) + delta = delta, but the log entry
    // would still carry undefined player metadata. Now we return null outright.
    const r = buildLifeChange(PLAYERS, 'gone', -7)
    expect(r).toBeNull()
  })
})
