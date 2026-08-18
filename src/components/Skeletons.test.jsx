// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppBootSkeleton, BrowserSkeleton, RowsSkeleton, TileGridSkeleton, ValueSkeleton } from './Skeletons'
import { CARD_GRID_DENSITY, gridColumnsForDensity, getCardGridDensity } from '../lib/cardGridDensity'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Query the data-skeleton attribute, not class names: CSS-module classes are
// hashed at build time, so a class selector is neither exact nor stable.
function placeholders(container) {
  return container.querySelectorAll('[data-skeleton]')
}
function ofKind(container, kind) {
  return container.querySelectorAll(`[data-skeleton="${kind}"]`)
}

describe('TileGridSkeleton', () => {
  it('renders one tile per requested count', () => {
    const { container } = render(<TileGridSkeleton count={4} />)
    expect(ofKind(container, 'tile')).toHaveLength(4)
  })

  // The tile stands in for a named folder with a count and a value, so it
  // carries those three shapes in those three places. A single solid block
  // would reflow the meta row into existence when the data lands.
  it('gives every tile a name and a meta row', () => {
    const { container } = render(<TileGridSkeleton count={3} />)
    expect(ofKind(container, 'tile-name')).toHaveLength(3)
    expect(ofKind(container, 'tile-count')).toHaveLength(3)
    expect(ofKind(container, 'tile-value')).toHaveLength(3)

    for (const tile of ofKind(container, 'tile')) {
      expect(tile.querySelector('[data-skeleton="tile-name"]')).not.toBeNull()
      expect(tile.querySelector('[data-skeleton="tile-value"]')).not.toBeNull()
    }
  })

  it('announces what is loading without exposing the placeholders', () => {
    const { container } = render(<TileGridSkeleton label="Loading binders" />)

    expect(screen.getByRole('status').textContent).toBe('Loading binders')
    // The grid itself is decorative — a screen reader should hear the status
    // message, not a run of empty regions.
    const hidden = container.querySelector('[aria-hidden="true"]')
    expect(hidden).not.toBeNull()
    expect(within(hidden).queryByRole('status')).toBeNull()
  })
})

describe('ValueSkeleton', () => {
  it('marks itself as a value placeholder', () => {
    const { container } = render(<ValueSkeleton />)
    expect(ofKind(container, 'value')).toHaveLength(1)
  })

  // One of these renders per tile. A live region on each would make a screen
  // reader announce every folder on the page the moment the grid paints, so
  // the label is readable in place rather than announced.
  it('labels itself for screen readers without being a live region', () => {
    render(<ValueSkeleton label="Value loading" />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Value loading')).not.toBeNull()
  })
})

describe('BrowserSkeleton', () => {
  // The browsers remember a view preference, so the placeholder has to match
  // the shape the user actually browses in — otherwise the page reflows twice.
  it('renders card placeholders in grid view', () => {
    const { container } = render(<BrowserSkeleton viewMode="grid" count={6} />)
    expect(ofKind(container, 'card')).toHaveLength(6)
    expect(ofKind(container, 'row')).toHaveLength(0)
  })

  it('renders row placeholders in the non-grid views', () => {
    for (const viewMode of ['stacks', 'table', 'text']) {
      cleanup()
      const { container } = render(<BrowserSkeleton viewMode={viewMode} count={5} />)
      expect(ofKind(container, 'card')).toHaveLength(0)
      expect(ofKind(container, 'row')).toHaveLength(5)
    }
  })

  it('always reserves the header block so the swap does not reflow', () => {
    const { container } = render(<BrowserSkeleton viewMode="grid" count={1} />)
    expect(container.querySelector('[data-skeleton="header-title"]')).not.toBeNull()
    expect(container.querySelector('[data-skeleton="header-controls"]')).not.toBeNull()
  })

  it('defaults to grid when no preference is passed', () => {
    const { container } = render(<BrowserSkeleton count={3} />)
    expect(ofKind(container, 'card')).toHaveLength(3)
  })

  // The live grid's column width is a user setting, so a fixed placeholder grid
  // showed the wrong number of columns to anyone not on the default: `cozy`
  // laid out roughly 1.6x too many, then swapped into far fewer, larger cards.
  //
  // Asserted against the helper rather than against literal strings — a literal
  // here would be the same copied-number mistake one level up, and would keep
  // passing after the density contract changed underneath it.
  it('lays out the grid at the density the browser is set to', () => {
    for (const density of Object.keys(CARD_GRID_DENSITY)) {
      cleanup()
      const { container } = render(<BrowserSkeleton viewMode="grid" count={3} density={density} />)
      const grid = container.querySelector('[data-skeleton="card"]').parentElement

      expect(grid.style.gridTemplateColumns).toBe(gridColumnsForDensity(density))
      expect(grid.style.columnGap).toBe(`${getCardGridDensity(density).desktopGap}px`)
      expect(grid.style.getPropertyValue('--skel-mobile-cols'))
        .toBe(String(getCardGridDensity(density).mobileCols))
    }
  })

  it('falls back to the default density rather than an unstyled grid', () => {
    const { container } = render(<BrowserSkeleton viewMode="grid" count={1} />)
    const grid = container.querySelector('[data-skeleton="card"]').parentElement
    expect(grid.style.gridTemplateColumns).toBe(gridColumnsForDensity('comfortable'))
  })

  // The real cell is art plus a name and a price line. An art-only placeholder
  // was ~90px short per row, so a screenful of them collapsed upward on load.
  it('gives every card placeholder the art, name and meta the real cell has', () => {
    const { container } = render(<BrowserSkeleton viewMode="grid" count={4} />)
    expect(ofKind(container, 'card-art')).toHaveLength(4)
    expect(ofKind(container, 'card-name')).toHaveLength(4)
    expect(ofKind(container, 'card-meta')).toHaveLength(4)
  })
})

describe('RowsSkeleton', () => {
  it('renders one row per requested count', () => {
    const { container } = render(<RowsSkeleton count={5} />)
    expect(ofKind(container, 'row')).toHaveLength(5)
  })

  // Each panel that uses it has a different row height, so the height has to
  // travel with the call — a single shared number would be wrong everywhere
  // but one place.
  it('takes its row height from the caller', () => {
    const { container } = render(<RowsSkeleton count={2} height={72} />)
    for (const row of ofKind(container, 'row')) {
      expect(row.style.height).toBe('72px')
    }
  })

  it('announces itself once rather than per row', () => {
    render(<RowsSkeleton count={4} label="Loading trade history" />)
    expect(screen.getByRole('status').textContent).toBe('Loading trade history')
  })

  // The four panels using this have gaps of 8, 10, 12 and 14px. Left to one
  // shared value the placeholder would be a different height from the list it
  // stands in for everywhere but one of them.
  it('takes its gap from the caller', () => {
    const { container } = render(<RowsSkeleton count={3} gap={12} />)
    expect(container.firstChild.style.gap).toBe('12px')
  })

  // Stats' game history is a `minmax(320px, 1fr)` grid, not a column. Handing
  // over the real class beats restating its columns inside this component.
  it('yields its container class to a caller whose list is not a column', () => {
    const { container } = render(<RowsSkeleton count={2} className="historyGrid" />)
    expect(container.firstChild.className).toBe('historyGrid')
  })
})

describe('AppBootSkeleton', () => {
  // This gate normally clears in a few milliseconds (the session is read from
  // localStorage), so it holds its blocks back rather than flashing a shimmer
  // for one frame. The status message is still there from the start, so the
  // wait is announced even while nothing is drawn.
  it('announces immediately but draws nothing until the delay elapses', () => {
    vi.useFakeTimers()
    const { container } = render(<AppBootSkeleton delayMs={150} />)

    expect(screen.getByRole('status').textContent).toBe('Loading DeckLoom')
    expect(placeholders(container)).toHaveLength(0)

    act(() => vi.advanceTimersByTime(149))
    expect(placeholders(container)).toHaveLength(0)

    act(() => vi.advanceTimersByTime(1))
    expect(placeholders(container).length).toBeGreaterThan(0)
  })

  it('marks itself busy so the gate is not mistaken for an empty page', () => {
    const { container } = render(<AppBootSkeleton />)
    expect(container.firstChild.getAttribute('aria-busy')).toBe('true')
  })
})
