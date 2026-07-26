// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import CardImg from './CardImg'

const SMALL = 'https://cards.scryfall.io/small/front/0/2/02e512b7.jpg?1698805228'
const NORMAL = 'https://cards.scryfall.io/normal/front/0/2/02e512b7.jpg?1698805228'
const LARGE = 'https://cards.scryfall.io/large/front/0/2/02e512b7.jpg?1698805228'
const GRID_WEBP = 'https://cards.scryfall.io/grid/front/0/2/02e512b7.webp?1698805228'

const OTHER_NORMAL = 'https://cards.scryfall.io/normal/front/9/9/99999999.jpg'
const OTHER_GRID_WEBP = 'https://cards.scryfall.io/grid/front/9/9/99999999.webp'

function setDpr(value) {
  window.devicePixelRatio = value
}

beforeEach(() => setDpr(1))
afterEach(cleanup)

describe('CardImg', () => {
  it('serves the WebP grid variant for tiles that resolve to the normal tier', () => {
    render(<CardImg url={NORMAL} width={244} alt="card" />)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(GRID_WEBP)
  })

  // The point of the component: call sites hand over whatever tier they happen
  // to store, and the rendered tier follows the element's real painted size.
  it('re-tiers whatever URL it is given to the width it renders at', () => {
    const { rerender } = render(<CardImg url={SMALL} width={244} alt="card" />)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(GRID_WEBP)

    rerender(<CardImg url={LARGE} width={146} alt="card" />)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(SMALL)
  })

  // The browser scales to device pixels, so a 146px tile on a phone needs a
  // bigger tier than the same tile on a plain monitor.
  it('follows devicePixelRatio', () => {
    setDpr(2)
    render(<CardImg url={SMALL} width={146} alt="card" />)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(GRID_WEBP)
  })

  // Regression: the grids used to force `normal`, which handed a DPR-1 desktop a
  // 3.3:1 browser reduction of the 488px render. Scryfall builds `small` at 146
  // with sharpening, so at a 1:1 fit it holds low-contrast card text the
  // reduction averages into mush. Comfortable density on a plain monitor is
  // exactly that fit, and it must not resolve to the 488 WebP.
  it('takes the sharpened 146px render when the tile is a 1:1 fit', () => {
    render(<CardImg url={NORMAL} width={146} alt="card" />)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(SMALL)
  })

  it('pins the tier when forceTier is given, ignoring width', () => {
    render(<CardImg url={SMALL} width={26} forceTier="normal" alt="card" />)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(GRID_WEBP)
  })

  // `grid` is an undocumented tier, so a 404 has to degrade to the JPEG rather
  // than leave a broken tile.
  it('falls back to the JPEG when the WebP fails to load', () => {
    render(<CardImg url={NORMAL} width={244} alt="card" />)
    const img = screen.getByAltText('card')
    fireEvent.error(img)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(NORMAL)
  })

  // Preview elements keep one instance across many cards; a failed WebP for one
  // card must not strand every later card on the fallback tier.
  it('retries the WebP after the URL changes', () => {
    const { rerender } = render(<CardImg url={NORMAL} width={244} alt="card" />)
    fireEvent.error(screen.getByAltText('card'))
    expect(screen.getByAltText('card').getAttribute('src')).toBe(NORMAL)

    rerender(<CardImg url={OTHER_NORMAL} width={244} alt="card" />)
    expect(screen.getByAltText('card').getAttribute('src')).toBe(OTHER_GRID_WEBP)
  })

  it('renders nothing without a usable URL', () => {
    const { container } = render(<CardImg url={null} width={244} alt="card" />)
    expect(container.querySelector('img')).toBe(null)
  })

  it('passes presentation props through to the img', () => {
    render(<CardImg url={NORMAL} width={244} alt="card" className="tile" loading="lazy" />)
    const img = screen.getByAltText('card')
    expect(img.className).toBe('tile')
    expect(img.getAttribute('loading')).toBe('lazy')
  })
})
