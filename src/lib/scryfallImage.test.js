import { describe, it, expect } from 'vitest'
import {
  scryfallImageAtSize,
  getImageUri,
  toScryfallGridWebp,
  pickImageTier,
  resolveTileImage,
  SCRYFALL_TIER_WIDTH,
} from './scryfall'

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

// The browser scales images to device pixels, so the tier has to follow DPR.
// Serving `small` to a retina laptop or an Android phone upscales it into mush -
// the bug this selection exists to prevent.
describe('pickImageTier', () => {
  const DENSITY_PX = { cozy: 244, comfortable: 146, compact: 122 }

  it('serves a mip-aligned tier on a plain 1x display', () => {
    expect(pickImageTier(DENSITY_PX.comfortable, 1)).toBe('small')  // 146 -> 146, 1:1
    expect(pickImageTier(DENSITY_PX.cozy, 1)).toBe('normal')        // 488 -> 244, 2:1
    // `small` (146) would *cover* a 122 tile, but reducing the sharpened
    // thumbnail is worse than a clean 488 -> 122; A/B'd both ways.
    expect(pickImageTier(DENSITY_PX.compact, 1)).toBe('normal')
  })

  // `small` carries sharpening baked in for 146px. Rescaling it in either
  // direction turns that into artifacts, so it is offered near native only.
  // Measured against a reduction from 488 on an old low-contrast frame and a
  // modern one: small wins at 146-153, loses by 128 and by 161. The compact
  // grid paints 113-132px, so it must never take small.
  it('offers small only within the band it was rendered for', () => {
    for (const painted of [113, 122, 128, 132, 161, 180]) {
      expect(pickImageTier(painted, 1)).toBe('normal')
    }
    for (const painted of [138.4, 146, 150.9, 153.2]) {
      expect(pickImageTier(painted, 1)).toBe('small')
    }
  })

  it('gives cozy a perfect 1:1 on a retina display', () => {
    expect(pickImageTier(DENSITY_PX.cozy, 2)).toBe('normal') // 244 * 2 = 488
  })

  it('steps up on retina and phone displays instead of upscaling', () => {
    for (const dpr of [2, 3]) {
      for (const px of Object.values(DENSITY_PX)) {
        const tier = pickImageTier(px, dpr)
        expect(SCRYFALL_TIER_WIDTH[tier]).toBeGreaterThanOrEqual(
          Math.min(px * dpr, SCRYFALL_TIER_WIDTH.large),
        )
      }
    }
  })

  // A tier may fall a few percent short rather than step up (see
  // UPSCALE_TOLERANCE), but never further — that is the line between an
  // imperceptible stretch and the mush this selection exists to prevent.
  it('never upscales a tile by more than the tolerance, at any ratio', () => {
    for (const dpr of [0.8, 1, 1.25, 1.5, 2, 2.625, 3, 4]) {
      for (const px of Object.values(DENSITY_PX)) {
        const width = SCRYFALL_TIER_WIDTH[pickImageTier(px, dpr)]
        const needed = px * dpr
        // `large` is the ceiling; beyond it there is nothing bigger to pick.
        if (needed <= SCRYFALL_TIER_WIDTH.large) expect(width * 1.06).toBeGreaterThanOrEqual(needed)
        else expect(width).toBe(SCRYFALL_TIER_WIDTH.large)
      }
    }
  })

  it('holds a tier that falls just short instead of stepping up', () => {
    expect(pickImageTier(147, 1)).toBe('small')   // 0.7% over 146 — not worth a 3.3:1 reduction
    expect(pickImageTier(489, 1)).toBe('normal')  // 0.2% over 488
    expect(pickImageTier(146, 2)).toBe('normal')  // 292: twice the tier, far past the tolerance
  })

  // The exact widths the desktop collection grid paints at common window sizes.
  // These straddle 146 by a few pixels, which is what made the same grid flip
  // between a sharpened thumbnail and a soft reduction as the window resized.
  it('keeps the comfortable grid on one tier across window widths', () => {
    for (const painted of [138.4, 143.8, 146.7, 150.9, 153.2]) {
      expect(pickImageTier(painted, 1)).toBe('small')
    }
    // Far enough over to be a real upscale — the reduction is better there.
    expect(pickImageTier(160.8, 1)).toBe('normal')
  })

  it('treats a missing or nonsense ratio as 1x', () => {
    expect(pickImageTier(146, 0)).toBe('small')
    expect(pickImageTier(146, undefined)).toBe('small')
  })
})

describe('resolveTileImage', () => {
  it('prefers the WebP and offers the JPEG as its fallback', () => {
    const { src, fallback } = resolveTileImage(NORMAL, 244, 1)
    expect(src).toBe('https://cards.scryfall.io/grid/front/0/2/02e512b7.webp?1698805228')
    expect(fallback).toBe(NORMAL)
  })

  // Regression: this used to rewrite the small URL to `grid`, silently serving a
  // 488px image to a tile that had deliberately asked for 146.
  it('leaves a small tile on small rather than upgrading it to the 488 WebP', () => {
    const { src, fallback } = resolveTileImage(NORMAL, 146, 1)
    expect(src).toBe('https://cards.scryfall.io/small/front/0/2/02e512b7.jpg?1698805228')
    expect(fallback).toBe(null)
  })

  it('is null-safe', () => {
    expect(resolveTileImage(null, 244, 1)).toEqual({ src: null, fallback: null })
  })

  // forceTier pins the tier so the card grids always render the 488 WebP,
  // regardless of the tile size / DPR that would otherwise pick a smaller tier.
  it('forces the normal WebP when forceTier is "normal", even for a small tile', () => {
    const { src, fallback } = resolveTileImage(NORMAL, 146, 1, 'normal')
    expect(src).toBe('https://cards.scryfall.io/grid/front/0/2/02e512b7.webp?1698805228')
    expect(fallback).toBe(NORMAL)
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
