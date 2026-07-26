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

// A card_prices query that records its chunk sizes and stays pending until the
// test releases it — that pending window is what proves the chunks were issued
// together instead of one after another.
function priceQuery(calls) {
  const query = {
    select: vi.fn(() => query),
    in: vi.fn((column, values) => {
      if (column === 'scryfall_id') calls.priceChunks.push(values.length)
      return query
    }),
    then: (resolve) => { calls.gate.push(() => resolve({ data: [], error: null })) },
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

    // firstPageSize pinned to the page size so this stays a test of the
    // full-catalogue paging boundary; the default 60-row first page has its own
    // tests below.
    const cards = await fetchPrintingsByName('Forest', {
      withPrices: false, language: 'all', firstPageSize: 1000,
    })

    expect(cards).toHaveLength(1001)
    expect(cards.at(-1)).toMatchObject({ released_at: '1993-08-05', finishes: ['foil'] })
    expect(calls.ranges).toEqual([[0, 999], [1000, 1999]])
    expect(calls.orders).toEqual(expect.arrayContaining(['released_at', 'created_at', 'scryfall_id']))
  })

  it('streams the newest page before the tail and still resolves with everything', async () => {
    const calls = { orders: [], ranges: [] }
    const head = Array.from({ length: 60 }, (_, index) => printRow(index))
    const tail = Array.from({ length: 40 }, (_, index) => printRow(60 + index))
    sb.from.mockReturnValue(printingQuery([
      { data: head, error: null },
      { data: tail, error: null },
    ], calls))

    const partials = []
    const cards = await fetchPrintingsByName('Forest', {
      withPrices: false,
      language: 'all',
      onPartial: partial => partials.push(partial.length),
    })

    expect(partials).toEqual([60])          // painted before the tail landed
    expect(cards).toHaveLength(100)
    expect(calls.ranges).toEqual([[0, 59], [60, 1059]])
  })

  it('skips the tail request entirely when the first page is the whole list', async () => {
    const calls = { orders: [], ranges: [] }
    sb.from.mockReturnValue(printingQuery([
      { data: [printRow(1), printRow(2)], error: null },
    ], calls))

    const cards = await fetchPrintingsByName('Lightning Bolt', { withPrices: false, language: 'all' })

    expect(cards).toHaveLength(2)
    expect(calls.ranges).toEqual([[0, 59]])
  })

  it('keeps the first page when the tail request fails', async () => {
    const calls = { orders: [], ranges: [] }
    const head = Array.from({ length: 60 }, (_, index) => printRow(index))
    sb.from.mockReturnValue(printingQuery([
      { data: head, error: null },
      { data: null, error: new Error('tail timed out') },
    ], calls))

    const cards = await fetchPrintingsByName('Forest', { withPrices: false, language: 'all' })

    expect(cards).toHaveLength(60)
    expect(sfGet).not.toHaveBeenCalled()   // a failed tail is not a catalogue outage
  })

  it('issues every price chunk in one wave', async () => {
    const calls = { orders: [], ranges: [], priceChunks: [], gate: [] }
    const rows = Array.from({ length: 450 }, (_, index) => printRow(index))
    sb.from.mockImplementation(table => (table === 'card_prices'
      ? priceQuery(calls)
      : printingQuery([{ data: rows, error: null }], calls)))

    // firstPageSize above the row count keeps this to a single printings page,
    // so the only thing in flight is the 450-id price fan-out (200/chunk).
    const promise = fetchPrintingsByName('Forest', { language: 'all', firstPageSize: 500 })
    await vi.waitFor(() => expect(calls.gate).toHaveLength(3))
    expect(calls.priceChunks).toEqual([200, 200, 50])

    calls.gate.forEach(release => release())
    expect(await promise).toHaveLength(450)
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
