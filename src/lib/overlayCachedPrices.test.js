// Cache-only price overlay — the first-paint half of the price load.
//
// The full overlay runs at the END of the card-map load, behind the metadata
// round trip, even though prices depend on none of it. Yesterday's and today's
// rows are already in IndexedDB, so this applies them immediately.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getLocalCardPriceRowsByIds = vi.fn()

vi.mock('./supabase', () => ({ sb: {} }))
vi.mock('./db', () => ({
  getLocalCardPriceRowsByIds: (...a) => getLocalCardPriceRowsByIds(...a),
  getLocalCardPriceRowsBySetCodes: vi.fn(async () => []),
  putCardPriceRows: vi.fn(async () => {}),
}))
vi.mock('./scryfall', () => ({
  enrichCards: vi.fn(),
  getInstantCache: vi.fn(),
  consumePrefetchedPriceRows: vi.fn(() => null),
}))

const { overlayCachedPricesOnly } = await import('./sharedCardPrices')

const iso = offset => {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const TODAY = iso(0)
const YESTERDAY = iso(-1)

const CARDS = [{ set_code: 'lea', collector_number: '1', scryfall_id: 'sf-1' }]
const BASE = { 'lea-1': { key: 'lea-1', image_uris: { normal: 'art.jpg' } } }

const row = (date, eur) => ({
  scryfall_id: 'sf-1', set_code: 'lea', collector_number: '1',
  snapshot_date: date, price_regular_eur: eur, updated_at: `${date}T00:00:00Z`,
})

beforeEach(() => {
  vi.clearAllMocks()
  getLocalCardPriceRowsByIds.mockResolvedValue([])
})

describe('overlayCachedPricesOnly', () => {
  it('applies a cached price without any network call', async () => {
    getLocalCardPriceRowsByIds.mockResolvedValue([row(TODAY, '2.50')])

    const out = await overlayCachedPricesOnly(CARDS, BASE)

    expect(out['lea-1'].prices?.eur).toBe('2.50')
    // Art must survive the merge — it is the whole point of seeding.
    expect(out['lea-1'].image_uris).toEqual({ normal: 'art.jpg' })
  })

  it("falls back to yesterday's row before today's is published", async () => {
    // The daily sync runs at 03:20 UTC, so early in the day today's row does
    // not exist yet. A day-old market price beats none.
    getLocalCardPriceRowsByIds.mockResolvedValue([row(YESTERDAY, '1.75')])

    const out = await overlayCachedPricesOnly(CARDS, BASE)

    expect(out['lea-1'].prices?.eur).toBe('1.75')
  })

  it("prefers today's row when both are cached", async () => {
    getLocalCardPriceRowsByIds.mockResolvedValue([row(YESTERDAY, '1.75'), row(TODAY, '2.50')])

    const out = await overlayCachedPricesOnly(CARDS, BASE)

    expect(out['lea-1'].prices?.eur).toBe('2.50')
    // Yesterday is kept so the UI can show a day-over-day delta.
    expect(out['lea-1'].prices_prev?.eur).toBe('1.75')
  })

  it('returns the base map untouched when nothing is cached', async () => {
    const out = await overlayCachedPricesOnly(CARDS, BASE)
    expect(out).toBe(BASE)
  })

  it('ignores rows marked missing', async () => {
    // Negative-cache markers record "we looked and there was no price"; they
    // must not be read as a price of zero.
    getLocalCardPriceRowsByIds.mockResolvedValue([{ ...row(TODAY, null), missing: true }])

    const out = await overlayCachedPricesOnly(CARDS, BASE)

    expect(out).toBe(BASE)
  })

  it('reads only today and yesterday', async () => {
    getLocalCardPriceRowsByIds.mockResolvedValue([row(TODAY, '2.50')])

    await overlayCachedPricesOnly(CARDS, BASE)

    expect(getLocalCardPriceRowsByIds).toHaveBeenCalledWith(['sf-1'], [TODAY, YESTERDAY])
  })

  it('skips the read entirely with no cards', async () => {
    expect(await overlayCachedPricesOnly([], BASE)).toBe(BASE)
    expect(getLocalCardPriceRowsByIds).not.toHaveBeenCalled()
  })
})
