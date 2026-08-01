import { describe, expect, it } from 'vitest'
import { cardImageUrl, tileArt, tileImage } from './buildAssistantTiles'

const sfEntry = url => ({ image_uris: { normal: url } })

const display = 'https://cards.scryfall.io/small/front/1/1/display.jpg'
const cached = 'https://cards.scryfall.io/normal/front/2/2/cached.jpg'
const fallback = 'https://edhrec.com/fallback.jpg'

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

describe('tileArt', () => {
  it('holds a skeleton while the display printing is unresolved', () => {
    // The whole point: the fallbacks ARE available here, and are deliberately
    // not used — painting one now means visibly swapping it out on arrival.
    expect(tileArt({ sfCard: sfEntry(cached), fallbackImg: fallback, resolved: false }))
      .toEqual({ state: 'pending', url: null })
  })

  it('paints the display printing once resolved', () => {
    expect(tileArt({ displayImg: display, sfCard: sfEntry(cached), resolved: true }))
      .toEqual({ state: 'image', url: display })
  })

  it('falls back normally for a name that resolved without an image', () => {
    expect(tileArt({ displayImg: null, fallbackImg: fallback, resolved: true }))
      .toEqual({ state: 'image', url: fallback })
  })

  it('reports no art when resolved and nothing is available', () => {
    expect(tileArt({ resolved: true })).toEqual({ state: 'none', url: null })
  })

  it('treats art as resolved by default', () => {
    // Callers that never request a display printing must not strand a skeleton.
    expect(tileArt({ fallbackImg: fallback })).toEqual({ state: 'image', url: fallback })
  })

  describe('preferOwned', () => {
    it('shows the owned copy over the cheaper printing you could buy', () => {
      // The owned copy is what Add actually puts in the deck.
      expect(tileArt({ displayImg: display, sfCard: sfEntry(cached), preferOwned: true }).url)
        .toContain('cached.jpg')
    })

    it('paints the owned copy immediately, without waiting on the lookup', () => {
      expect(tileArt({ sfCard: sfEntry(cached), resolved: false, preferOwned: true }))
        .toMatchObject({ state: 'image' })
    })

    it('falls back to the normal chain when the collection has no art cached', () => {
      expect(tileArt({ displayImg: display, sfCard: null, preferOwned: true }))
        .toEqual({ state: 'image', url: display })
    })

    it('still skeletons an owned card with no cached art and an unresolved lookup', () => {
      expect(tileArt({ sfCard: null, fallbackImg: fallback, resolved: false, preferOwned: true }))
        .toEqual({ state: 'pending', url: null })
    })
  })
})
