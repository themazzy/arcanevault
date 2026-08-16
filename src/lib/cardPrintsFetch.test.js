// Behaviour of the batched card_prints reads, which carry the daily metadata
// refresh for the whole collection. See collectionperfplan.md §1.2.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const select = vi.fn()
vi.mock('./supabase', () => ({
  sb: { from: () => ({ select: (...a) => select(...a) }) },
}))

const { fetchCardPrintsByScryfallIds } = await import('./cardPrints')

/** Mimics the PostgREST builder: `.select(cols).in(col, values)` resolves. */
function mockIn(handler) {
  select.mockImplementation(() => ({ in: (_col, values) => handler(values) }))
}

const ids = n => Array.from({ length: n }, (_, i) => `id-${i}`)

describe('fetchCardPrintsByScryfallIds', () => {
  beforeEach(() => { select.mockReset() })

  it('batches 11,354 ids into 200-row requests', async () => {
    // The real collection size that motivated the change: 57 batches.
    let calls = 0
    mockIn(values => {
      calls++
      expect(values.length).toBeLessThanOrEqual(200)
      return Promise.resolve({ data: values.map(id => ({ scryfall_id: id })), error: null })
    })

    const out = await fetchCardPrintsByScryfallIds(ids(11354))

    expect(calls).toBe(Math.ceil(11354 / 200))
    expect(out.size).toBe(11354)
  })

  it('issues batches concurrently, but bounded', async () => {
    // Two failure modes, one on each side. Serial (peak 1) is the bug §1.2
    // fixes; unbounded (peak 20 here, 57 for a real collection) would be the
    // bug introduced by fixing it carelessly — that many simultaneous requests
    // against an 8-connection PostgREST pool is exactly what the limit avoids.
    let inFlight = 0
    let peak = 0
    mockIn(async values => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 2))
      inFlight--
      return { data: values.map(id => ({ scryfall_id: id })), error: null }
    })

    await fetchCardPrintsByScryfallIds(ids(4000)) // 20 batches

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })

  it('retries a transient batch failure instead of failing the whole fetch', async () => {
    // A throw here makes enrichFromCardPrints hand all cards to Scryfall at
    // 75/batch + 120ms — roughly 18s. One bad batch must not cause that.
    let failed = false
    mockIn(values => {
      if (!failed && values.includes('id-250')) {
        failed = true
        return Promise.resolve({ data: null, error: { message: 'timeout' } })
      }
      return Promise.resolve({ data: values.map(id => ({ scryfall_id: id })), error: null })
    })

    const out = await fetchCardPrintsByScryfallIds(ids(600))

    expect(failed).toBe(true)
    expect(out.size).toBe(600)
  })

  it('rejects rather than returning a partial map when a batch never recovers', async () => {
    // A half-filled map would be cached and then read as complete, which is
    // worse than failing to the Scryfall fallback.
    mockIn(values =>
      values.includes('id-0')
        ? Promise.resolve({ data: null, error: { message: 'down' } })
        : Promise.resolve({ data: values.map(id => ({ scryfall_id: id })), error: null }),
    )

    await expect(fetchCardPrintsByScryfallIds(ids(600))).rejects.toBeTruthy()
  })

  it('de-duplicates ids and skips the round trip when there are none', async () => {
    mockIn(values => Promise.resolve({ data: values.map(id => ({ scryfall_id: id })), error: null }))

    const out = await fetchCardPrintsByScryfallIds(['a', 'a', 'a', null, undefined, 'b'])
    expect(out.size).toBe(2)

    select.mockClear()
    expect((await fetchCardPrintsByScryfallIds([])).size).toBe(0)
    expect(select).not.toHaveBeenCalled()
  })
})
