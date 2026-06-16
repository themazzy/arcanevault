import { describe, it, expect } from 'vitest'
import { scryfallImageAtSize, getImageUri } from './scryfall'

const NORMAL = 'https://cards.scryfall.io/normal/front/0/2/02e512b7.jpg?1698805228'

describe('scryfallImageAtSize', () => {
  it('rewrites the size segment of a Scryfall CDN URL', () => {
    expect(scryfallImageAtSize(NORMAL, 'small'))
      .toBe('https://cards.scryfall.io/small/front/0/2/02e512b7.jpg?1698805228')
    expect(scryfallImageAtSize(NORMAL, 'large'))
      .toBe('https://cards.scryfall.io/large/front/0/2/02e512b7.jpg?1698805228')
  })

  it('leaves non-Scryfall URLs unchanged', () => {
    expect(scryfallImageAtSize('https://example.com/x.jpg', 'small')).toBe('https://example.com/x.jpg')
  })

  it('is null-safe', () => {
    expect(scryfallImageAtSize(null, 'small')).toBeNull()
    expect(scryfallImageAtSize(NORMAL, null)).toBe(NORMAL)
  })
})

describe('getImageUri', () => {
  it('returns the stored URL for a size it has', () => {
    const card = { image_uris: { small: 'S', normal: 'N', large: 'L' } }
    expect(getImageUri(card, 'small')).toBe('S')
    expect(getImageUri(card, 'large')).toBe('L')
  })

  it("derives a missing size from the entry's stored URL (card_prints has only normal)", () => {
    const card = { image_uris: { normal: NORMAL } }
    expect(getImageUri(card, 'small'))
      .toBe('https://cards.scryfall.io/small/front/0/2/02e512b7.jpg?1698805228')
    expect(getImageUri(card, 'normal')).toBe(NORMAL)
  })

  it('reads the front face of a double-faced card', () => {
    const dfc = { card_faces: [{ image_uris: { normal: NORMAL } }] }
    expect(getImageUri(dfc, 'small')).toContain('/small/')
  })

  it('returns null when there is no image data', () => {
    expect(getImageUri({}, 'small')).toBeNull()
    expect(getImageUri(null, 'small')).toBeNull()
  })
})
