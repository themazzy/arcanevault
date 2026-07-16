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

function Detail({ card, ...rest }) {
  return (
    <MemoryRouter>
      <CardDetail card={card} sfCard={SF_CARD} readOnly onClose={vi.fn()} {...rest} />
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

  it('has no Card tab — its text lives beside the image, always visible', () => {
    render(<Detail card={CARD} />)
    // The former "Card" tab button is gone; read-only surfaces have no "Edit" tab.
    expect(screen.queryByRole('button', { name: 'Card' })).toBe(null)
    expect(screen.queryByRole('button', { name: 'Edit' })).toBe(null)
    // Oracle text is rendered regardless of which tab is active.
    expect(screen.getByText('A card used to verify conditional detail rendering.')).toBeTruthy()
  })

  it('defaults a read-only surface to the Prices tab', () => {
    render(<Detail card={CARD} />)
    expect(screen.getByText('All prices')).toBeTruthy()
  })

  it('honors readOnlyDefaultTab (deck builder opens on Legality, not Prices)', () => {
    render(<Detail card={CARD} readOnlyDefaultTab="legality" />)
    expect(screen.queryByText('All prices')).toBe(null)
  })

  it('defaults an editable surface to the Edit tab', () => {
    render(
      <MemoryRouter>
        <CardDetail card={CARD} sfCard={SF_CARD} onClose={vi.fn()} onSave={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy()
  })
})
