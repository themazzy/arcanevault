import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ sb: {} }))

import { todayDateString, computeValueDelta } from './valueSnapshots'

describe('todayDateString', () => {
  it('formats a local YYYY-MM-DD date', () => {
    expect(todayDateString(new Date(2026, 5, 12))).toBe('2026-06-12')
    expect(todayDateString(new Date(2026, 0, 3))).toBe('2026-01-03')
  })
})

describe('computeValueDelta', () => {
  const now = new Date(2026, 5, 12) // 2026-06-12
  const rows = [
    { snapshot_date: '2026-05-10', total_eur: 100, total_usd: 110 },
    { snapshot_date: '2026-06-05', total_eur: 120, total_usd: 130 },
    { snapshot_date: '2026-06-11', total_eur: 140, total_usd: 150 },
  ]

  it('compares against the closest snapshot at least N days old', () => {
    // 7 days before 06-12 = 06-05 → baseline is the 06-05 row (120)
    const d7 = computeValueDelta(rows, 150, 'total_eur', 7, now)
    expect(d7.abs).toBeCloseTo(30)
    expect(d7.pct).toBeCloseTo(25)
    expect(d7.sinceDate).toBe('2026-06-05')

    // 30 days back → only the 05-10 row qualifies (100)
    const d30 = computeValueDelta(rows, 150, 'total_eur', 30, now)
    expect(d30.abs).toBeCloseTo(50)
    expect(d30.sinceDate).toBe('2026-05-10')
  })

  it('returns null when no snapshot is old enough', () => {
    expect(computeValueDelta(rows, 150, 'total_eur', 60, now)).toBeNull()
    expect(computeValueDelta([], 150, 'total_eur', 7, now)).toBeNull()
    expect(computeValueDelta(rows, null, 'total_eur', 7, now)).toBeNull()
  })

  it('handles a zero baseline without dividing by zero', () => {
    const zeroRows = [{ snapshot_date: '2026-06-01', total_eur: 0 }]
    const delta = computeValueDelta(zeroRows, 50, 'total_eur', 7, now)
    expect(delta.abs).toBe(50)
    expect(delta.pct).toBeNull()
  })
})
