import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ sb: { from: vi.fn() } }))
vi.mock('./scryfall', () => ({
  sfGet: vi.fn(),
  scryfallImageAtSize: (url) => url,
}))

import { fetchPrintingsByName, fetchPrintingsForNames } from './cardSearch'
import { sb } from './supabase'
import { sfGet } from './scryfall'

function printRow(index, extra = {}) {
  return {
    scryfall_id: `print-${index}`,
    name: 'Forest',
    set_code: `s${index}`,
    collector_number: String(index),
    lang: 'en',
    released_at: '2026-01-01',
    finishes: ['nonfoil', 'foil'],
    ...extra,
  }
}

function printingQuery(pages, calls) {
  const query = {
    select: vi.fn(() => query),
    not: vi.fn(() => query),
    or: vi.fn(() => query),
    order: vi.fn((column) => { calls.orders.push(column); return query }),
    eq: vi.fn(() => query),
    like: vi.fn(() => query),
    in: vi.fn(() => query),
    range: vi.fn(async (from, to) => {
      calls.ranges.push([from, to])
      return pages.shift() || { data: [], error: null }
    }),
  }
  return query
}

describe('card printing catalog queries', () => {
  beforeEach(() => {
    sb.from.mockReset()
    sfGet.mockReset()
  })

  it('pages deterministically and preserves authoritative release/finish metadata', async () => {
    const calls = { orders: [], ranges: [] }
    const first = Array.from({ length: 1000 }, (_, index) => printRow(index))
    const second = [printRow(1000, { released_at: '1993-08-05', finishes: ['foil'] })]
    sb.from.mockReturnValue(printingQuery([
      { data: first, error: null },
      { data: second, error: null },
    ], calls))

    const cards = await fetchPrintingsByName('Forest', { withPrices: false, language: 'all' })

    expect(cards).toHaveLength(1001)
    expect(cards.at(-1)).toMatchObject({ released_at: '1993-08-05', finishes: ['foil'] })
    expect(calls.ranges).toEqual([[0, 999], [1000, 1999]])
    expect(calls.orders).toEqual(expect.arrayContaining(['released_at', 'created_at', 'scryfall_id']))
  })

  it('filters Scryfall face-name collisions on the fallback path', async () => {
    const calls = { orders: [], ranges: [] }
    sb.from.mockReturnValue(printingQuery([{ data: null, error: new Error('catalog down') }], calls))
    sfGet.mockResolvedValue({
      data: [
        { id: 'wrong', name: 'Naktamun Lorespinner // Wheel of Fortune' },
        { id: 'right', name: 'Wheel of Fortune' },
      ],
      has_more: false,
    })

    const cards = await fetchPrintingsByName('Wheel of Fortune', { withPrices: false, language: 'all' })

    expect(cards.map(card => card.id)).toEqual(['right'])
    expect(sfGet.mock.calls[0][0]).toContain('game%3Apaper')
  })

  it('resolves a front-face name to full-name DB printings in a batch', async () => {
    const calls = { orders: [], ranges: [] }
    const fullName = 'Bala Ged Recovery // Bala Ged Sanctuary'
    sb.from.mockReturnValue(printingQuery([
      { data: [], error: null },
      { data: [], error: null },
      { data: [printRow(1, { name: fullName })], error: null },
    ], calls))

    const cards = await fetchPrintingsForNames(['Bala Ged Recovery'], {
      withPrices: false,
      language: 'all',
    })

    expect(cards).toHaveLength(1)
    expect(cards[0].name).toBe(fullName)
    expect(sfGet).not.toHaveBeenCalled()
    expect(calls.ranges).toHaveLength(3)
  })
})
