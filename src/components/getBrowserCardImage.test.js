import { describe, it, expect } from 'vitest'
import {
  getBrowserCardImage,
  DENSITY_IMAGE,
  GRID_IMG_BORDER_PX,
  gridColumnsForDensity,
} from './CardBrowserViews.jsx'
import { toScryfallGridWebp, pickImageTier, SCRYFALL_TIER_WIDTH } from '../lib/scryfall'

const sf = {
  image_uris: { small: 'S', normal: 'N', large: 'L' },
}
const dfc = {
  card_faces: [{ image_uris: { small: 'FS', normal: 'FN' } }],
}
const SMALL_URL = 'https://cards.scryfall.io/small/front/5/e/5e644586.jpg'
const NORMAL_URL = 'https://cards.scryfall.io/normal/front/5/e/5e644586.jpg'

describe('getBrowserCardImage', () => {
  it('defaults to the normal size (what the grid uses)', () => {
    expect(getBrowserCardImage({}, sf)).toBe('N')
  })

  it('returns the requested size when present', () => {
    expect(getBrowserCardImage({}, sf, 'small')).toBe('S')
    expect(getBrowserCardImage({}, sf, 'large')).toBe('L')
  })

  it('falls back to normal when the requested size is missing', () => {
    const noNormalPreferred = { image_uris: { normal: 'N' } }
    expect(getBrowserCardImage({}, noNormalPreferred, 'large')).toBe('N')
  })

  it('reads image_uris from the front face of a DFC', () => {
    expect(getBrowserCardImage({}, dfc)).toBe('FN')
  })

  it('upgrades a stray small-size fallback URL (e.g. tokens) to the requested size', () => {
    // Token rows often only carry a `small` URL in image_uri; the grid asks for
    // normal, so it must be lifted to match the sharp cards beside it.
    expect(getBrowserCardImage({ image_uri: SMALL_URL }, null)).toBe(NORMAL_URL)
  })

  it('leaves a small URL untouched when small is actually requested', () => {
    expect(getBrowserCardImage({ image_uri: SMALL_URL }, null, 'small')).toBe(SMALL_URL)
  })

  // Regression: normalization used to only rewrite `small/`, so a stored `large`
  // URL rendered at 672 no matter what tile size asked for it — those cards were
  // the ones shimmering in an otherwise clean grid.
  it('downgrades a stray large-size fallback URL to the requested size', () => {
    const LARGE_URL = 'https://cards.scryfall.io/large/front/5/e/5e644586.jpg'
    expect(getBrowserCardImage({ image_uri: LARGE_URL }, null)).toBe(NORMAL_URL)
    expect(getBrowserCardImage({ image_uri: LARGE_URL }, null, 'small')).toBe(SMALL_URL)
  })

  it('folds a png URL onto the requested jpg tier', () => {
    const PNG_URL = 'https://cards.scryfall.io/png/front/5/e/5e644586.png'
    expect(getBrowserCardImage({ image_uri: PNG_URL }, null)).toBe(NORMAL_URL)
    expect(getBrowserCardImage({ image_uri: PNG_URL }, null, 'small')).toBe(SMALL_URL)
  })

  // A browser tile always wants the whole card, so a row that only stored a crop
  // still has to resolve to the full-card image at the requested tier — never to
  // the crop itself, which would silently show different art to its neighbours.
  it('pulls art_crop/border_crop rows back to the full card at the requested size', () => {
    const ART = 'https://cards.scryfall.io/art_crop/front/5/e/5e644586.jpg'
    const BORDER = 'https://cards.scryfall.io/border_crop/front/5/e/5e644586.jpg'
    expect(getBrowserCardImage({ image_uri: ART }, null)).toBe(NORMAL_URL)
    expect(getBrowserCardImage({ image_uri: BORDER }, null, 'small')).toBe(SMALL_URL)
  })

  it('preserves the query string when retiering', () => {
    expect(getBrowserCardImage({ image_uri: `${SMALL_URL}?123` }, null)).toBe(`${NORMAL_URL}?123`)
  })

  it('returns null when nothing is available', () => {
    expect(getBrowserCardImage({}, null)).toBe(null)
  })
})

describe('toScryfallGridWebp', () => {
  it('rewrites a normal JPEG to the grid WebP tier', () => {
    expect(toScryfallGridWebp(NORMAL_URL))
      .toBe('https://cards.scryfall.io/grid/front/5/e/5e644586.webp')
  })

  it('rewrites the other JPEG tiers too', () => {
    expect(toScryfallGridWebp(SMALL_URL))
      .toBe('https://cards.scryfall.io/grid/front/5/e/5e644586.webp')
    expect(toScryfallGridWebp('https://cards.scryfall.io/large/front/5/e/5e644586.jpg'))
      .toBe('https://cards.scryfall.io/grid/front/5/e/5e644586.webp')
  })

  it('preserves the cache-busting query string', () => {
    expect(toScryfallGridWebp(`${NORMAL_URL}?1783920572`))
      .toBe('https://cards.scryfall.io/grid/front/5/e/5e644586.webp?1783920572')
  })

  it('returns null for a URL it cannot rewrite, so callers keep the original', () => {
    expect(toScryfallGridWebp('https://example.com/card.jpg')).toBe(null)
    expect(toScryfallGridWebp('https://cards.scryfall.io/art_crop/front/5/e/5e644586.jpg')).toBe(null)
    expect(toScryfallGridWebp(null)).toBe(null)
    expect(toScryfallGridWebp(undefined)).toBe(null)
  })
})

// Tiles shimmer unless each density renders its source at (or just under) one of
// that source's mipmap levels. These are the numbers the comments claim — pin
// them so a future density tweak can't silently drift off a level.
describe('grid density mip alignment', () => {
  const mipLevels = (width) => {
    const levels = []
    for (let w = width; w >= 1; w = Math.floor(w / 2)) levels.push(w)
    return levels
  }

  // At 1x these widths must be mip levels of whichever tier they resolve to, or
  // the browser squeezes a level by an awkward ratio and the tile shimmers.
  it('renders every density at an exact mip level of its 1x tier', () => {
    for (const spec of Object.values(DENSITY_IMAGE)) {
      const tierWidth = SCRYFALL_TIER_WIDTH[pickImageTier(spec.px, 1)]
      expect(mipLevels(tierWidth)).toContain(spec.px)
    }
  })

  it('never asks the browser to upscale, at any realistic ratio', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      for (const spec of Object.values(DENSITY_IMAGE)) {
        const tierWidth = SCRYFALL_TIER_WIDTH[pickImageTier(spec.px, dpr)]
        const needed = spec.px * dpr
        if (needed <= SCRYFALL_TIER_WIDTH.large) expect(tierWidth).toBeGreaterThanOrEqual(needed)
      }
    }
  })

  it('keeps the densities visually distinct and correctly ordered', () => {
    const widths = ['compact', 'comfortable', 'cozy'].map(d => DENSITY_IMAGE[d].px)
    expect(widths).toEqual([...widths].sort((a, b) => a - b))
    // A middle step that collapses onto a neighbour makes the density pointless.
    expect(widths[1] - widths[0]).toBeGreaterThan(20)
    expect(widths[2] - widths[1]).toBeGreaterThan(20)
  })

  it('only asks for WebP from the 488 tier, which is the one that has it', () => {
    // `grid` is WebP-only and 488-wide; `large`/`small` are JPEG-only.
    for (const spec of Object.values(DENSITY_IMAGE)) {
      if (spec.webp) expect(spec.size).toBe('normal')
    }
  })

  it('never lets a density fall below its own cap', () => {
    for (const spec of Object.values(DENSITY_IMAGE)) {
      expect(spec.min).toBeLessThanOrEqual(spec.px)
    }
  })

  // Regression: the first cut capped the grid *column*, but `.gridImgWrap` is
  // border-box with a 1px border, so every <img> rendered 2px narrower than
  // intended and missed its level (cozy 242 not 244, comfortable 166 not 168).
  it('widens the column by the wrap border so the image itself hits the level', () => {
    expect(gridColumnsForDensity('cozy')).toBe('repeat(auto-fill, minmax(210px, 246px))')
    expect(gridColumnsForDensity('compact')).toBe('repeat(auto-fill, minmax(112px, 124px))')
    for (const [density, spec] of Object.entries(DENSITY_IMAGE)) {
      const cap = Number(gridColumnsForDensity(density).match(/(\d+)px\)\)$/)[1])
      expect(cap - GRID_IMG_BORDER_PX).toBe(spec.px)
    }
  })

  it('falls back to a real density for an unknown one', () => {
    expect(gridColumnsForDensity('bogus')).toBe(gridColumnsForDensity('comfortable'))
  })
})
