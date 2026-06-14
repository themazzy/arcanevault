import { describe, it, expect } from 'vitest'
import { buyLinksForCard, BUY_VENDORS } from './buyLinks'

describe('buyLinksForCard', () => {
  it('returns a link per vendor, name-searched by default', () => {
    const links = buyLinksForCard({ name: 'Sol Ring' })
    expect(links.map(l => l.id)).toEqual(['tcgplayer', 'cardmarket', 'cardkingdom'])
    expect(links[0].url).toContain('tcgplayer.com')
    expect(links[0].url).toContain('q=Sol%20Ring')
    expect(links[1].url).toContain('cardmarket.com')
    expect(links[1].url).toContain('searchString=Sol%20Ring')
    expect(links[2].url).toContain('cardkingdom.com')
    expect(links[2].url).toContain('Sol%20Ring')
  })

  it('prefers Scryfall purchase_uris for exact deep links (not Card Kingdom)', () => {
    const links = buyLinksForCard({
      name: 'Sol Ring',
      purchase_uris: {
        tcgplayer: 'https://www.tcgplayer.com/product/12345',
        cardmarket: 'https://www.cardmarket.com/en/Magic/Products/Singles/x/Sol-Ring',
      },
    })
    const byId = Object.fromEntries(links.map(l => [l.id, l.url]))
    expect(byId.tcgplayer).toBe('https://www.tcgplayer.com/product/12345')
    expect(byId.cardmarket).toContain('/Singles/')
    // Card Kingdom is always a name search (no Scryfall URI)
    expect(byId.cardkingdom).toContain('filter%5Bname%5D=Sol%20Ring')
  })

  it('ignores non-http purchase URIs and falls back to search', () => {
    const links = buyLinksForCard({ name: 'Sol Ring', purchase_uris: { tcgplayer: 'javascript:alert(1)' } })
    expect(links.find(l => l.id === 'tcgplayer').url).toContain('tcgplayer.com/search')
  })

  it('returns [] when there is no name', () => {
    expect(buyLinksForCard({})).toEqual([])
    expect(buyLinksForCard(null)).toEqual([])
  })

  it('escapes names that contain URL-special characters', () => {
    const links = buyLinksForCard({ name: 'Borrowing 100,000 Arrows' })
    expect(links[0].url).toContain('100%2C000')
  })

  it('exposes a stable vendor list', () => {
    expect(BUY_VENDORS).toHaveLength(3)
  })
})
