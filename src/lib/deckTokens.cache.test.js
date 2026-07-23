import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sfGet: vi.fn(),
  getMeta: vi.fn(),
  setMeta: vi.fn(),
}))

vi.mock('./scryfall', () => ({ sfGet: mocks.sfGet }))
vi.mock('./db', () => ({ getMeta: mocks.getMeta, setMeta: mocks.setMeta }))

async function loadModule() {
  return import('./deckTokens')
}

describe('deck token card loading', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.sfGet.mockReset()
    mocks.getMeta.mockReset().mockResolvedValue(null)
    mocks.setMeta.mockReset().mockResolvedValue(undefined)
  })

  it('uses a fresh persistent token-card entry without calling Scryfall', async () => {
    const card = {
      name: 'Treasure',
      image_uris: { normal: 'normal.jpg', small: 'small.jpg' },
    }
    mocks.getMeta.mockResolvedValue({
      entries: {
        'token:treasure': { fetchedAt: Date.now(), card },
      },
    })

    const { fetchDeckTokenCard } = await loadModule()
    const result = await fetchDeckTokenCard({ name: 'Treasure', kind: 'token' }, 'small')

    expect(result.imageUri).toBe('small.jpg')
    expect(result.card).toEqual(card)
    expect(mocks.sfGet).not.toHaveBeenCalled()
  })

  it('shares one in-flight Scryfall request for the same token', async () => {
    let resolveSearch
    mocks.sfGet.mockImplementation(() => new Promise(resolve => { resolveSearch = resolve }))

    const { fetchDeckTokenCard } = await loadModule()
    const first = fetchDeckTokenCard({ name: 'Food', kind: 'token' }, 'small')
    const second = fetchDeckTokenCard({ name: 'Food', kind: 'token' }, 'normal')

    await vi.waitFor(() => expect(mocks.sfGet).toHaveBeenCalledTimes(1))
    resolveSearch({
      data: [{ name: 'Food', image_uris: { normal: 'normal.jpg', small: 'small.jpg' } }],
    })

    const [small, normal] = await Promise.all([first, second])
    expect(small.imageUri).toBe('small.jpg')
    expect(normal.imageUri).toBe('normal.jpg')
    await vi.waitFor(() => expect(mocks.setMeta).toHaveBeenCalledTimes(1))
    expect(mocks.setMeta.mock.calls[0][1].entries['token:food'].card.name).toBe('Food')
  })

  it('does not persist a failed Scryfall request as a missing token', async () => {
    mocks.sfGet.mockResolvedValue(null)

    const { fetchDeckTokenCard } = await loadModule()
    const result = await fetchDeckTokenCard({ name: 'Soldier', kind: 'token' }, 'small')

    expect(result.imageUri).toBeNull()
    expect(mocks.setMeta).not.toHaveBeenCalled()
  })

  it('resolves multiple tokens two at a time and reports each result immediately', async () => {
    let active = 0
    let maxActive = 0
    mocks.sfGet.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { data: [{ image_uris: { small: 'token.jpg' } }] }
    })

    const { fetchDeckTokenCards } = await loadModule()
    const seen = []
    const items = ['Treasure', 'Food', 'Clue'].map(name => ({ name, kind: 'token' }))
    const results = await fetchDeckTokenCards(items, 'small', {
      concurrency: 2,
      onResult: result => seen.push(result.name),
    })

    expect(maxActive).toBe(2)
    expect(results).toHaveLength(3)
    expect(seen).toHaveLength(3)
    expect(new Set(seen)).toEqual(new Set(['Treasure', 'Food', 'Clue']))
  })
})
