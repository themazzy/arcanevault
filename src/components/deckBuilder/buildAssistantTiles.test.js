import { describe, expect, it } from 'vitest'
import { cardImageUrl, tileImage } from './buildAssistantTiles'

const sfEntry = url => ({ image_uris: { normal: url } })

describe('cardImageUrl', () => {
  it('returns null without a card', () => {
    expect(cardImageUrl(null)).toBeNull()
  })

  it('falls back to the normal tier when the entry stores no small URL', () => {
    // card_prints-derived entries only carry `normal`; without this fallback
    // owned tiles rendered blank.
    const url = 'https://cards.scryfall.io/normal/front/a/b/abc.jpg'
    expect(cardImageUrl(sfEntry(url))).toContain('abc.jpg')
  })
})

describe('tileImage', () => {
  const display = 'https://cards.scryfall.io/small/front/1/1/display.jpg'
  const cached = 'https://cards.scryfall.io/normal/front/2/2/cached.jpg'
  const fallback = 'https://edhrec.com/fallback.jpg'

  it('prefers the resolved display printing over cached collection art', () => {
    // The tile and the hover preview both read this, so the enlarged card is
    // the same printing the grid painted.
    expect(tileImage({ displayImg: display, sfCard: sfEntry(cached), fallbackImg: fallback }))
      .toBe(display)
  })

  it('uses cached collection art when no display printing resolved yet', () => {
    expect(tileImage({ sfCard: sfEntry(cached), fallbackImg: fallback })).toContain('cached.jpg')
  })

  it('falls back last to the unowned-upgrade art', () => {
    expect(tileImage({ sfCard: null, fallbackImg: fallback })).toBe(fallback)
  })

  it('returns null when nothing resolves', () => {
    expect(tileImage()).toBeNull()
    expect(tileImage({ displayImg: null, sfCard: null, fallbackImg: null })).toBeNull()
  })
})
