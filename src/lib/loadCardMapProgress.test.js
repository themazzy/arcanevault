// Progress reporting for Collection's card-map load.
//
// Until 2026-08-16 the bar reported nothing on the path everyone actually
// takes: onProgress reached only fetchAndMerge, the Scryfall fallback, which
// stopped running once card_prints covered whole collections. Collection
// renders the bar as `enriching && progLabel`, so an empty label meant a
// silent 10-15s wait on a phone with no feedback at all.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getInstantCache = vi.fn()
const enrichCards = vi.fn()

// Minimal PostgREST stand-in that resolves empty. Without it the price fetch
// throws and overlaySharedCardPrices returns early, which hides the very
// reporting these tests exist to check.
vi.mock('./supabase', () => ({
  sb: {
    from: () => {
      const q = { select: () => q, in: () => q, then: (res) => Promise.resolve({ data: [], error: null }).then(res) }
      return q
    },
  },
}))
vi.mock('./db', () => ({
  getLocalCardPriceRowsByIds: vi.fn(async () => []),
  getLocalCardPriceRowsBySetCodes: vi.fn(async () => []),
  putCardPriceRows: vi.fn(async () => {}),
}))
vi.mock('./scryfall', () => ({
  enrichCards: (...a) => enrichCards(...a),
  getInstantCache: (...a) => getInstantCache(...a),
  consumePrefetchedPriceRows: vi.fn(() => []),
}))

const { loadCardMapWithSharedPrices } = await import('./sharedCardPrices')

const CARDS = [{ set_code: 'lea', collector_number: '1', scryfall_id: 'sf-1' }]
const CACHED = { 'lea-1': { key: 'lea-1', type_line: 'Instant', oracle_text: '' } }

beforeEach(() => {
  vi.clearAllMocks()
  getInstantCache.mockResolvedValue(CACHED)
  enrichCards.mockImplementation(async () => CACHED)
})

/** Collect [pct, label] pairs in call order. */
async function capture(cards = CARDS) {
  const seen = []
  await loadCardMapWithSharedPrices(cards, {
    onProgress: (pct, label) => seen.push([pct, label]),
    priceLookup: 'set',
  })
  return seen
}

describe('loadCardMapWithSharedPrices progress', () => {
  it('reports named stages, not silence', async () => {
    const labels = [...new Set((await capture()).map(([, l]) => l))].filter(Boolean)

    // The specific failure being guarded: zero labelled updates, which renders
    // no bar at all.
    expect(labels.length).toBeGreaterThan(0)
    expect(labels).toContain('Reading local cache')
    expect(labels).toContain('Updating prices')
  })

  it('never moves backwards', async () => {
    const pcts = (await capture()).map(([p]) => p)
    const sorted = [...pcts].sort((a, b) => a - b)
    // A bar that jumps back reads as broken even when the work is progressing.
    expect(pcts).toEqual(sorted)
  })

  it('stays within 0-100', async () => {
    for (const [pct] of await capture()) {
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
  })

  it('ends at 100 with a blank label so the bar dismisses', async () => {
    // Collection renders on `enriching && progLabel`; the empty label is what
    // hides it.
    expect((await capture()).at(-1)).toEqual([100, ''])
  })

  it('advances past the metadata stage even when nothing needs enriching', async () => {
    // The common warm case. Reporting 100% here (as the old code did) would
    // dismiss the bar while the price overlay was still running.
    const seen = await capture()
    expect(enrichCards).not.toHaveBeenCalled()

    const beforePrices = seen.filter(([, l]) => l === 'Loading card details')
    expect(beforePrices.length).toBeGreaterThan(0)
    // Metadata completing must not read as the whole job completing.
    expect(beforePrices.every(([p]) => p < 100)).toBe(true)
  })

  it('scales an inner reporter into the metadata stage rather than the whole bar', async () => {
    // Enrichment reporting "50%" means half of ITS stage, not half of the load.
    const uncached = [{ set_code: 'lea', collector_number: '9', scryfall_id: 'sf-9' }]
    getInstantCache.mockResolvedValue({})
    enrichCards.mockImplementation(async (_cards, onProgress) => {
      onProgress?.(0)
      onProgress?.(50)
      onProgress?.(100)
      return {}
    })

    const seen = await capture(uncached)
    const meta = seen.filter(([, l]) => l === 'Loading card details').map(([p]) => p)

    expect(meta.length).toBeGreaterThanOrEqual(3)
    // Bounded by the stage window, never spanning the full bar.
    expect(Math.min(...meta)).toBeGreaterThanOrEqual(8)
    expect(Math.max(...meta)).toBeLessThanOrEqual(72)
  })

  it('keeps a richer inner label when one is supplied', async () => {
    // fetchAndMerge counts cards ("Fetching card data… (150 / 900)"), which
    // beats the generic stage name.
    getInstantCache.mockResolvedValue({})
    enrichCards.mockImplementation(async (_cards, onProgress) => {
      onProgress?.(40, 'Fetching card data… (150 / 900)')
      return {}
    })

    const seen = await capture([{ set_code: 'lea', collector_number: '9', scryfall_id: 'sf-9' }])
    expect(seen.some(([, l]) => l === 'Fetching card data… (150 / 900)')).toBe(true)
  })

  it('does not let an inner blank label hide the bar mid-run', async () => {
    // Several inner callers signal "stage done" with (100, ''). Forwarding that
    // blank would dismiss the bar while prices were still loading.
    getInstantCache.mockResolvedValue({})
    enrichCards.mockImplementation(async (_cards, onProgress) => {
      onProgress?.(100, '')
      return {}
    })

    const seen = await capture([{ set_code: 'lea', collector_number: '9', scryfall_id: 'sf-9' }])
    const blanks = seen.filter(([, l]) => !l)
    // Only the final dismissal may be blank.
    expect(blanks).toEqual([[100, '']])
  })
})

describe('loadCardMapWithSharedPrices metadata publish', () => {
  it('publishes the map before prices so images need not wait', async () => {
    // The cold-cache case: a private tab or a new device has nothing to seed
    // from, so without this the grid stays imageless for the whole load and
    // every image appears at once when the price stage ends.
    const order = []
    getInstantCache.mockResolvedValue({})
    enrichCards.mockImplementation(async () => {
      order.push('enrich')
      return CACHED
    })

    await loadCardMapWithSharedPrices(
      [{ set_code: 'lea', collector_number: '9', scryfall_id: 'sf-9' }],
      {
        priceLookup: 'set',
        onProgress: (_p, label) => { if (label === 'Updating prices') order.push('prices') },
        onMetadataReady: () => order.push('publish'),
      },
    )

    expect(order.indexOf('publish')).toBeGreaterThan(order.indexOf('enrich'))
    expect(order.indexOf('publish')).toBeLessThan(order.indexOf('prices'))
  })

  it('hands over a map that actually carries card art', async () => {
    // Publishing early is only useful if image_uri is present by then.
    let published = null
    getInstantCache.mockResolvedValue({})
    enrichCards.mockResolvedValue({ 'lea-9': { key: 'lea-9', type_line: 'Instant', image_uris: { normal: 'art.jpg' } } })

    await loadCardMapWithSharedPrices(
      [{ set_code: 'lea', collector_number: '9', scryfall_id: 'sf-9' }],
      { priceLookup: 'set', onMetadataReady: m => { published = m } },
    )

    expect(published?.['lea-9']?.image_uris?.normal).toBe('art.jpg')
  })

  it('does not publish an empty map', async () => {
    // An empty publish would blank a grid that the IDB seed may already have
    // populated.
    const seen = []
    getInstantCache.mockResolvedValue({})
    enrichCards.mockResolvedValue({})

    await loadCardMapWithSharedPrices(
      [{ set_code: 'lea', collector_number: '9', scryfall_id: 'sf-9' }],
      { priceLookup: 'set', onMetadataReady: m => seen.push(m) },
    )

    expect(seen).toEqual([])
  })

  it('publishes even when nothing needs enriching', async () => {
    // The warm-cache path, and the one the binder/deck/wishlist browsers hit
    // most: everything is already in IndexedDB, enrichCards never runs, and the
    // publish must still fire — before any network — or those browsers gain
    // nothing from the early hand-off.
    let published = null
    getInstantCache.mockResolvedValue(CACHED)

    await loadCardMapWithSharedPrices(CARDS, {
      priceLookup: 'set',
      onMetadataReady: m => { published = m },
    })

    expect(enrichCards).not.toHaveBeenCalled()
    expect(published).toEqual(CACHED)
  })

  it('still returns the priced map when the consumer throws', async () => {
    // A render error in the early publish must not take down the whole load.
    getInstantCache.mockResolvedValue(CACHED)

    const result = await loadCardMapWithSharedPrices(CARDS, {
      priceLookup: 'set',
      onMetadataReady: () => { throw new Error('render blew up') },
    })

    expect(result).toBeTruthy()
    expect(result['lea-1']).toBeTruthy()
  })
})
