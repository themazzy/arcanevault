import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeckGridSkeleton } from './Builder'

describe('DeckGridSkeleton', () => {
  const countTiles = html => (html.match(/_skeletonCard_/g) || []).length

  it('renders six placeholder tiles by default', () => {
    expect(countTiles(renderToStaticMarkup(<DeckGridSkeleton />))).toBe(6)
  })

  it('honours an explicit count', () => {
    expect(countTiles(renderToStaticMarkup(<DeckGridSkeleton count={3} />))).toBe(3)
  })

  it('reuses the real deck grid so the layout does not shift on load', () => {
    expect(renderToStaticMarkup(<DeckGridSkeleton />)).toContain('_grid_')
  })

  it('announces itself as busy with a caller-supplied label', () => {
    const html = renderToStaticMarkup(<DeckGridSkeleton label="Loading community decks" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('aria-label="Loading community decks"')
  })
})
