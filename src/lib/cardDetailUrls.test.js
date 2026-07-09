import { describe, it, expect } from 'vitest'
import { scryfallCardDetailUrls } from './cardDetailUrls'

describe('scryfallCardDetailUrls', () => {
  it('prefers the exact scryfall id, then set/collector, then named', () => {
    const urls = scryfallCardDetailUrls({
      name: 'Sol Ring',
      scryfall_id: 'abc-123',
      set_code: 'C21',
      collector_number: '263',
    })
    expect(urls).toEqual([
      'https://api.scryfall.com/cards/abc-123',
      'https://api.scryfall.com/cards/c21/263',
      'https://api.scryfall.com/cards/named?exact=Sol%20Ring&format=json',
    ])
  })

  it('falls back to set/collector when there is no scryfall id', () => {
    const urls = scryfallCardDetailUrls({ name: 'Sol Ring', set_code: 'LEA', collector_number: '270★' })
    expect(urls[0]).toBe('https://api.scryfall.com/cards/lea/270%E2%98%85')
    expect(urls[1]).toContain('named?exact=')
  })

  it('handles a bare name string (combo cards not in the deck)', () => {
    expect(scryfallCardDetailUrls('Thassa\'s Oracle')).toEqual([
      "https://api.scryfall.com/cards/named?exact=Thassa's%20Oracle&format=json",
    ])
  })

  it('returns no URLs for empty input', () => {
    expect(scryfallCardDetailUrls(null)).toEqual([])
    expect(scryfallCardDetailUrls({})).toEqual([])
  })
})
