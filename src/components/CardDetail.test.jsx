// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardDetail } from './CardComponents'

const CARD = {
  id: 'card-1',
  name: 'Regression Test Card',
  qty: 1,
  foil: false,
  condition: 'near_mint',
  language: 'en',
  set_code: 'tst',
  collector_number: '1',
}

const SF_CARD = {
  name: CARD.name,
  set_name: 'Test Set',
  type_line: 'Artifact Creature — Test',
  mana_cost: '{1}{W} // {2}{U}',
  oracle_text: 'A card used to verify conditional detail rendering.',
  prices: {},
}

function Detail({ card }) {
  return (
    <MemoryRouter>
      <CardDetail card={card} sfCard={SF_CARD} readOnly onClose={vi.fn()} />
    </MemoryRouter>
  )
}

describe('CardDetail', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('safely transitions between no card and a rendered card', () => {
    const { container, rerender } = render(<Detail card={null} />)
    expect(container.innerHTML).toBe('')

    rerender(<Detail card={CARD} />)
    expect(screen.getAllByText('Artifact Creature — Test').length).toBeGreaterThan(0)
    expect(screen.getByText('A card used to verify conditional detail rendering.')).toBeTruthy()
    expect(screen.getByText('//')).toBeTruthy()

    rerender(<Detail card={null} />)
    expect(screen.queryByText('Artifact Creature — Test')).toBe(null)
  })
})
