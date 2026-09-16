import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchDisplay = vi.fn()
vi.mock('../../lib/cardSearch', () => ({
  fetchDeckBuilderDisplayPrintings: (...args) => fetchDisplay(...args),
}))

const { displayPrintingKey, resolveDisplayPrintings } = await import('./buildAssistantPricing')

// One row in the shape get_deck_builder_display_printings returns.
const row = (name, price) => ({
  requested_name: name,
  display_price: price,
  display_finish: 'nonfoil',
  image_uris: { small: `https://img/${name.toLowerCase()}.jpg` },
})

// Stand-in for the two React state setters the resolver writes through.
function stateCell(initial) {
  const cell = { value: initial }
  return [cell, updater => { cell.value = updater(cell.value) }]
}

function harness() {
  const [cheapest, setCheapest] = stateCell(new Map())
  const [failed, setFailed] = stateCell(new Set())
  const inFlight = new Set()
  return { cheapest, failed, inFlight, setCheapest, setFailed }
}

beforeEach(() => {
  fetchDisplay.mockReset()
})

describe('resolveDisplayPrintings', () => {
  it('writes each name into the cache under its price-source key and frees the in-flight keys', async () => {
    fetchDisplay.mockResolvedValue([row('Sol Ring', 1.5), row('Cultivate', 0.25)])
    const h = harness()

    await resolveDisplayPrintings({
      names: ['Sol Ring', 'Cultivate'],
      priceSource: 'cardmarket_trend',
      inFlight: h.inFlight,
      setCheapest: h.setCheapest,
      setFailed: h.setFailed,
    })

    expect(h.cheapest.value.get('cardmarket_trend:sol ring')).toEqual({
      price: 1.5, image: 'https://img/sol ring.jpg', finish: 'nonfoil',
    })
    expect(h.cheapest.value.get('cardmarket_trend:cultivate')?.price).toBe(0.25)
    expect(h.inFlight.size).toBe(0)
    expect(h.failed.value.size).toBe(0)
  })

  it('caches a name the database returned nothing for, so its tile stops waiting', async () => {
    fetchDisplay.mockResolvedValue([])
    const h = harness()

    await resolveDisplayPrintings({
      names: ['Unpriced Card'],
      priceSource: 'cardmarket_trend',
      inFlight: h.inFlight,
      setCheapest: h.setCheapest,
      setFailed: h.setFailed,
    })

    // Present in the cache (so `artResolved` is true) with no price — not absent.
    expect(h.cheapest.value.has('cardmarket_trend:unpriced card')).toBe(true)
    expect(h.cheapest.value.get('cardmarket_trend:unpriced card')).toEqual({
      price: null, image: null, finish: null,
    })
  })

  it('marks a failed batch failed and leaves the cache untouched for a later retry', async () => {
    fetchDisplay.mockRejectedValue(new Error('statement timeout'))
    const h = harness()

    await resolveDisplayPrintings({
      names: ['Sol Ring'],
      priceSource: 'cardmarket_eur',
      inFlight: h.inFlight,
      setCheapest: h.setCheapest,
      setFailed: h.setFailed,
    })

    expect(h.failed.value.has('cardmarket_eur:sol ring')).toBe(true)
    expect(h.cheapest.value.size).toBe(0)
    expect(h.inFlight.size).toBe(0)
  })

  it('holds its keys in flight for the whole batch, so an overlapping caller does not refetch them', async () => {
    let release
    fetchDisplay.mockReturnValue(new Promise(res => { release = () => res([row('Sol Ring', 1.5)]) }))
    const h = harness()

    const running = resolveDisplayPrintings({
      names: ['Sol Ring'],
      priceSource: 'cardmarket_trend',
      inFlight: h.inFlight,
      setCheapest: h.setCheapest,
      setFailed: h.setFailed,
    })
    expect(h.inFlight.has('cardmarket_trend:sol ring')).toBe(true)

    release()
    await running
    expect(h.inFlight.has('cardmarket_trend:sol ring')).toBe(false)
  })

  // The regression. A batch whose effect run was superseded must still land:
  // the superseding run sees the keys in flight, fetches nothing and returns
  // without starting a batch of its own, so if the first batch's write is
  // discarded nothing will ever resolve those names and the tile grid
  // (`gridSettled`) shimmers forever.
  it('still writes a batch that was abandoned by the caller that started it', async () => {
    let release
    fetchDisplay.mockReturnValue(new Promise(res => { release = () => res([row('Sol Ring', 1.5)]) }))
    const h = harness()
    const priceSource = 'cardmarket_trend'
    const names = ['Sol Ring']

    // Effect run 1 starts the batch and is never awaited (fire and forget).
    const batch = resolveDisplayPrintings({
      names, priceSource, inFlight: h.inFlight, setCheapest: h.setCheapest, setFailed: h.setFailed,
    })

    // Effect run 2 supersedes it: same call-site filter, and every name is
    // already in flight, so it has nothing to fetch and starts no batch.
    const stillMissing = names.filter(n =>
      !h.cheapest.value.has(displayPrintingKey(priceSource, n))
      && !h.inFlight.has(displayPrintingKey(priceSource, n)))
    expect(stillMissing).toEqual([])
    expect(fetchDisplay).toHaveBeenCalledTimes(1)

    release()
    await batch

    // Run 1's result is the only one there will ever be, so it must be kept.
    expect(h.cheapest.value.get('cardmarket_trend:sol ring')?.price).toBe(1.5)
  })

  it('does nothing when there is nothing to resolve', async () => {
    const h = harness()
    await resolveDisplayPrintings({
      names: [], priceSource: 'cardmarket_trend', inFlight: h.inFlight,
      setCheapest: h.setCheapest, setFailed: h.setFailed,
    })
    expect(fetchDisplay).not.toHaveBeenCalled()
    expect(h.cheapest.value.size).toBe(0)
  })
})
