import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { CommunityDeckTile } from './Builder'

// The tile renders the deck name as a real <Link> so Ctrl/middle-click can open
// it in a new tab, which means it needs a router in scope.
function renderTile({ meta, fmt, deck }) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CommunityDeckTile
        deck={{ id: 'deck-1', name: 'Atraxa', type: 'builder_deck', ...deck }}
        meta={meta}
        fmt={fmt}
        isOwn={false}
        creatorNick={null}
        navigate={() => {}}
      />
    </MemoryRouter>,
  )
}

describe('CommunityDeckTile bracket badge', () => {
  it('shows persisted bracket metadata for Commander decks', () => {
    const html = renderTile({
      meta: { format: 'commander', bracket: 3 },
      fmt: { id: 'commander', label: 'Commander', isEDH: true },
    })

    expect(html).toContain('B3 · Upgraded')
  })

  it('does not show stale bracket metadata for non-EDH formats', () => {
    const html = renderTile({
      meta: { format: 'modern', bracket: 3 },
      fmt: { id: 'modern', label: 'Modern', isEDH: false },
    })

    expect(html).not.toContain('B3')
    expect(html).not.toContain('Upgraded')
  })
})

describe('CommunityDeckTile keyboard affordance', () => {
  const commander = { id: 'commander', label: 'Commander / EDH', isEDH: true, deckSize: 100 }

  it('exposes the tile as a focusable button with a descriptive label', () => {
    const html = renderTile({
      meta: { format: 'commander', commanderName: 'Atraxa, Praetors\' Voice' },
      fmt: commander,
      deck: { card_count: 100 },
    })

    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="Atraxa, Atraxa, Praetors&#x27; Voice, 100 cards"')
  })

  it('renders the deck name as a link so it can be opened in a new tab', () => {
    const html = renderTile({ meta: { format: 'commander' }, fmt: commander })
    expect(html).toContain('href="/d/deck-1"')
  })
})

describe('CommunityDeckTile card count', () => {
  const commander = { id: 'commander', label: 'Commander / EDH', isEDH: true, deckSize: 100 }

  it('shows the plain count, with no target and no meter', () => {
    const html = renderTile({ meta: { format: 'commander' }, fmt: commander, deck: { card_count: 117 } })
    expect(html).toContain('117 cards')
    expect(html).not.toContain('/ 100')
    expect(html).not.toContain('countMeter')
  })

  it('renders nothing, and claims no count, when the count is unknown', () => {
    const html = renderTile({ meta: { format: 'commander' }, fmt: commander, deck: { card_count: null } })
    expect(html).not.toContain('cards<')
    // An unknown count must not be announced as "0 cards".
    expect(html).toContain('aria-label="Atraxa"')
  })
})

describe('CommunityDeckTile badges', () => {
  it('marks a collection deck with text, not an icon', () => {
    const html = renderTile({
      meta: { format: 'commander' },
      fmt: { id: 'commander', label: 'Commander / EDH', isEDH: true },
      deck: { type: 'deck' },
    })
    expect(html).toContain('Collection')
    expect(html).toContain('collectionBadge')
  })

  it('keeps the description and tags on the tile', () => {
    const html = renderTile({
      meta: { format: 'commander', deckDescription: 'A **grindy** midrange pile.', tags: ['midrange', 'budget'] },
      fmt: { id: 'commander', label: 'Commander / EDH', isEDH: true },
    })
    expect(html).toContain('A grindy midrange pile.')
    expect(html).toContain('midrange')
    expect(html).toContain('budget')
  })
})
