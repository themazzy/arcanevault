// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserSkeleton, TileGridSkeleton } from './Skeletons'

afterEach(cleanup)

// Query the data-skeleton attribute, not class names: CSS-module classes are
// hashed at build time, so a class selector is neither exact nor stable.
function placeholders(container) {
  return container.querySelectorAll('[data-skeleton]')
}
function ofKind(container, kind) {
  return container.querySelectorAll(`[data-skeleton="${kind}"]`)
}

describe('TileGridSkeleton', () => {
  it('renders one placeholder per tile', () => {
    const { container } = render(<TileGridSkeleton count={4} />)
    expect(ofKind(container, 'tile')).toHaveLength(4)
    expect(placeholders(container)).toHaveLength(4)
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
})
