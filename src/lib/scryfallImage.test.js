import { describe, it, expect } from 'vitest'
import { scryfallImageAtSize, getImageUri, toScryfallGridWebp } from './scryfall'

const NORMAL = 'https://cards.scryfall.io/normal/front/0/2/02e512b7.jpg?1698805228'
const PNG = 'https://cards.scryfall.io/png/front/0/2/02e512b7.png?1698805228'

describe('scryfallImageAtSize', () => {
  it('rewrites the size segment of a Scryfall CDN URL', () => {
    expect(scryfallImageAtSize(NORMAL, 'small'))
      .toBe('https://cards.scryfall.io/small/front/0/2/02e512b7.jpg?1698805228')
    expect(scryfallImageAtSize(NORMAL, 'large'))
      .toBe('https://cards.scryfall.io/large/front/0/2/02e512b7.jpg?1698805228')
  })

  // `png` is the only tier with its own extension, so the extension has to move
  // with the size segment — otherwise the derived URL (e.g. normal/....png) 404s.
  it('moves the extension when converting to or from the png tier', () => {
    expect(scryfallImageAtSize(PNG, 'normal')).toBe(NORMAL)
    expect(scryfallImageAtSize(PNG, 'small'))
      .toBe('https://cards.scryfall.io/small/front/0/2/02e512b7.jpg?1698805228')
    expect(scryfallImageAtSize(NORMAL, 'png')).toBe(PNG)
  })

  it('leaves non-Scryfall URLs unchanged', () => {
    expect(scryfallImageAtSize('https://example.com/x.jpg', 'small')).toBe('https://example.com/x.jpg')
    expect(scryfallImageAtSize('https://example.com/x.png', 'normal')).toBe('https://example.com/x.png')
  })

  // Deck-builder tiles thumbnail whatever tier a row stored. They used to do it
  // with a hand-rolled segment swap that left the extension alone, so a png row
  // resolved to small/....png and 404'd — every tier must reach a real .jpg.
  it('thumbnails every tier a row might store to a loadable small URL', () => {
    const SMALL = 'https://cards.scryfall.io/small/front/0/2/02e512b7.jpg?1698805228'
    for (const tier of ['normal', 'large', 'border_crop', 'art_crop']) {
      const url = `https://cards.scryfall.io/${tier}/front/0/2/02e512b7.jpg?1698805228`
      expect(scryfallImageAtSize(url, 'small')).toBe(SMALL)
    }
    expect(scryfallImageAtSize(PNG, 'small')).toBe(SMALL)
  })

  it('is null-safe', () => {
    expect(scryfallImageAtSize(null, 'small')).toBeNull()
    expect(scryfallImageAtSize(NORMAL, null)).toBe(NORMAL)
  })
})

describe('toScryfallGridWebp', () => {
  it('rewrites any jpg tier to the grid WebP tier, keeping the query', () => {
    expect(toScryfallGridWebp(NORMAL))
      .toBe('https://cards.scryfall.io/grid/front/0/2/02e512b7.webp?1698805228')
    expect(toScryfallGridWebp('https://cards.scryfall.io/large/front/0/2/02e512b7.jpg'))
      .toBe('https://cards.scryfall.io/grid/front/0/2/02e512b7.webp')
  })

  it('returns null when it cannot rewrite, so callers keep the original', () => {
    // art_crop is a different crop and has no grid tier; png is not a jpg tier.
    expect(toScryfallGridWebp('https://cards.scryfall.io/art_crop/front/0/2/02e512b7.jpg')).toBe(null)
    expect(toScryfallGridWebp(PNG)).toBe(null)
    expect(toScryfallGridWebp('https://example.com/x.jpg')).toBe(null)
    expect(toScryfallGridWebp(null)).toBe(null)
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
