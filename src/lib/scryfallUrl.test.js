import { describe, it, expect, vi } from 'vitest'

// scryfall.js pulls in IDB + card_prints + perf at import time. Stub them so the
// module loads in the node test env and we can exercise the pure sfUrl helper.
vi.mock('./db', () => ({
  getAllScryfallEntries: vi.fn(), putScryfallEntries: vi.fn(),
  clearScryfallStore: vi.fn(), getScryfallCacheInfo: vi.fn(),
  setMeta: vi.fn(), getMeta: vi.fn(),
}))
vi.mock('./cardPrints', () => ({
  cardPrintRowToSfEntry: vi.fn(), fetchCardPrintsByScryfallIds: vi.fn(),
  fetchCardPrintsBySetCollector: vi.fn(), ensureCardPrints: vi.fn(),
}))
vi.mock('./perf', () => ({ perfSpan: (_name, fn) => fn() }))

const { sfUrl } = await import('./scryfall')

describe('sfUrl', () => {
  it('returns absolute Scryfall URLs unchanged (no dev-proxy rewrite)', () => {
    const url = 'https://api.scryfall.com/cards/search?q=%22Roxanne%22+is%3Acommander'
    expect(sfUrl(url)).toBe(url)
  })

  it('normalizes a leading-slash path onto the Scryfall origin', () => {
    expect(sfUrl('/cards/named?exact=Sol+Ring'))
      .toBe('https://api.scryfall.com/cards/named?exact=Sol+Ring')
  })

  it('never rewrites to the removed /api/scryfall dev proxy', () => {
    // Regression: the old sfUrl rewrote api.scryfall.com → /api/scryfall in dev,
    // but that Vite proxy was removed, so every dev Scryfall request 404'd to the
    // SPA index.html and search silently returned nothing.
    expect(sfUrl('https://api.scryfall.com/cards/search?q=x')).not.toContain('/api/scryfall')
    expect(sfUrl('/cards/search?q=x')).not.toContain('/api/scryfall')
  })
})
