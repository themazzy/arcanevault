import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommunityDeckTile } from './Builder'

function renderTile({ meta, fmt }) {
  return renderToStaticMarkup(
    <CommunityDeckTile
      deck={{ id: 'deck-1', name: 'Atraxa', type: 'builder_deck' }}
      meta={meta}
      fmt={fmt}
      isOwn={false}
      creatorNick={null}
      navigate={() => {}}
    />,
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
