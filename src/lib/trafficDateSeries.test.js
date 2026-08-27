import { describe, expect, it } from 'vitest'
import {
  enumerateDates,
  fillDailySeries,
} from '../../supabase/functions/admin-traffic-summary/dateSeries.ts'

describe('enumerateDates', () => {
  it('is inclusive of both ends', () => {
    expect(enumerateDates('2026-08-25', '2026-08-28')).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
    ])
  })

  it('returns a single day when both ends match', () => {
    expect(enumerateDates('2026-08-27', '2026-08-27')).toEqual(['2026-08-27'])
  })

  it('crosses a month boundary', () => {
    expect(enumerateDates('2026-07-30', '2026-08-02')).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ])
  })

  it('crosses a DST boundary without dropping or repeating a day', () => {
    // Europe/Prague springs forward on 2026-03-29. Local-time arithmetic would
    // land on 23:00 of the previous day and repeat a date; UTC does not.
    const dates = enumerateDates('2026-03-27', '2026-03-31')
    expect(dates).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'])
    expect(new Set(dates).size).toBe(dates.length)
  })

  it('returns nothing for a reversed or malformed range', () => {
    expect(enumerateDates('2026-08-28', '2026-08-25')).toEqual([])
    expect(enumerateDates('nonsense', '2026-08-25')).toEqual([])
  })

  it('is bounded so a bad range cannot spin', () => {
    expect(enumerateDates('1970-01-01', '2026-08-27').length).toBe(400)
  })
})

describe('fillDailySeries', () => {
  const range = { since: '2026-08-25', until: '2026-08-28', zero: { views: 0 } }

  it('inserts zero rows for days with no data', () => {
    const filled = fillDailySeries([{ date: '2026-08-27', views: 5 }], range)
    expect(filled).toEqual([
      { date: '2026-08-25', views: 0 },
      { date: '2026-08-26', views: 0 },
      { date: '2026-08-27', views: 5 },
      { date: '2026-08-28', views: 0 },
    ])
  })

  it('produces a full range from no data at all', () => {
    expect(fillDailySeries([], range).map(r => r.views)).toEqual([0, 0, 0, 0])
    expect(fillDailySeries(null, range)).toHaveLength(4)
  })

  it('orders by date regardless of input order', () => {
    const filled = fillDailySeries(
      [{ date: '2026-08-28', views: 2 }, { date: '2026-08-25', views: 1 }],
      range
    )
    expect(filled.map(r => r.date)).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
    ])
  })

  it('drops rows outside the range rather than lengthening the series', () => {
    const filled = fillDailySeries(
      [{ date: '2026-01-01', views: 99 }, { date: '2026-08-26', views: 3 }],
      range
    )
    expect(filled).toHaveLength(4)
    expect(filled.find(r => r.views === 99)).toBeUndefined()
  })

  it('ignores rows with a missing or non-string date', () => {
    const filled = fillDailySeries([{ date: null, views: 7 }, { views: 8 }], range)
    expect(filled.every(r => r.views === 0)).toBe(true)
  })

  it('keeps every zero key so the chart never reads undefined', () => {
    const filled = fillDailySeries([], {
      since: '2026-08-27',
      until: '2026-08-27',
      zero: { page_views: 0, visits: 0 },
    })
    expect(filled[0]).toEqual({ date: '2026-08-27', page_views: 0, visits: 0 })
  })
})
