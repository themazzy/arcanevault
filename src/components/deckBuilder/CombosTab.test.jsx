// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CombosTab from './CombosTab'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const combo = {
  uses: [
    { card: { name: 'Cass, Hand of Vengeance' } },
    { card: { name: 'Griffin Guide' } },
    { card: { name: 'Goblin Bombardment' } },
  ],
}

function renderTab({ deckCards, included = [], almost = [] }) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })))
  return render(
    <CombosTab
      deckCards={deckCards}
      combosFetched
      combosLoading={false}
      combosIncluded={included}
      combosAlmost={almost}
      comboSectionsOpen={{ complete: true, incomplete: true }}
      onToggleSection={() => {}}
      onFetchCombos={() => {}}
      onAddCard={() => {}}
      onOpenDetail={() => {}}
      deckImagesMap={{}}
    />,
  )
}

describe('CombosTab combo-piece deck membership', () => {
  it('requests a combo check without forwarding the click event as a deck override', () => {
    const onFetchCombos = vi.fn()
    render(
      <CombosTab
        deckCards={[{ name: 'Sol Ring', board: 'main' }]}
        combosFetched={false}
        combosLoading={false}
        combosIncluded={[]}
        combosAlmost={[]}
        comboSectionsOpen={{ complete: true, incomplete: true }}
        onToggleSection={() => {}}
        onFetchCombos={onFetchCombos}
        onAddCard={() => {}}
        onOpenDetail={() => {}}
        deckImagesMap={{}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Find Combos' }))

    expect(onFetchCombos).toHaveBeenCalledOnce()
    expect(onFetchCombos).toHaveBeenCalledWith()
  })

  it('marks a combo piece on the maybeboard as missing — only commander + main board are sent to Spellbook', () => {
    renderTab({
      deckCards: [
        { name: 'Cass, Hand of Vengeance', board: 'main', is_commander: true },
        { name: 'Griffin Guide', board: 'main', is_commander: false },
        { name: 'Goblin Bombardment', board: 'maybe', is_commander: false },
      ],
      almost: [combo],
    })
    expect(screen.getByText('Add Goblin Bombardment')).toBeTruthy()
    expect(screen.getAllByText('Griffin Guide').length).toBeGreaterThan(0)
    expect(screen.queryByText('Add Griffin Guide')).toBeNull()
  })

  it('counts commander and main-board pieces as in deck for complete combos', () => {
    renderTab({
      deckCards: [
        { name: 'Cass, Hand of Vengeance', board: 'main', is_commander: true },
        { name: 'Griffin Guide', board: 'main', is_commander: false },
        { name: 'Goblin Bombardment', board: 'main', is_commander: false },
      ],
      included: [combo],
    })
    expect(screen.queryByText(/^Add /)).toBeNull()
  })
})
