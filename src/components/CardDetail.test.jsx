// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardDetail } from './CardComponents'

vi.mock('../lib/supabase', () => ({
  sb: { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) },
}))
vi.mock('../lib/db', () => ({ putCards: vi.fn().mockResolvedValue(undefined) }))

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

  it('points the sliding tab underline at the active tab', async () => {
    render(<Detail card={CARD} />)
    const bar = document.querySelector('[style*="--tab-count"]')
    // Read-only: Prices / Rulings / Legality, opening on Prices.
    expect(bar.style.getPropertyValue('--tab-count')).toBe('3')
    expect(bar.style.getPropertyValue('--tab-index')).toBe('0')

    await userEvent.click(screen.getByRole('button', { name: 'Legality' }))
    expect(bar.style.getPropertyValue('--tab-index')).toBe('2')
  })

  it('shows the set code as its own meta field, after the set name', () => {
    render(<Detail card={CARD} />)
    // Separators are CSS ::before, so the fields are plain adjacent spans.
    expect(screen.getByText('Test Set')).toBeTruthy()
    expect(screen.getByText('TST')).toBeTruthy()
    expect(screen.getByText('#1')).toBeTruthy()
  })

  it('does not repeat the set code as the name when the set name is unknown', () => {
    // sfCard with no set_name — the first field falls back to the code, and the
    // dedicated code field is dropped rather than rendering "TST • TST".
    render(
      <MemoryRouter>
        <CardDetail card={CARD} sfCard={{ ...SF_CARD, set_name: undefined }} readOnly onClose={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.getAllByText('TST').length).toBe(1)
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

  // Each editable test uses its own set/collector number: fetchFullCard and
  // fetchPrintingLanguages both memoize on that key at module scope.
  function Editable({ card, ...rest }) {
    return (
      <MemoryRouter>
        <CardDetail card={card} sfCard={SF_CARD} onClose={vi.fn()} onSave={vi.fn()} {...rest} />
      </MemoryRouter>
    )
  }

  function stubLanguageSearch(langs) {
    vi.stubGlobal('fetch', vi.fn(url => String(url).includes('/cards/search')
      ? Promise.resolve({ ok: true, json: async () => ({ data: langs.map(lang => ({ lang })) }) })
      : Promise.resolve({ ok: false })))
  }

  it('offers only the languages the printing was actually released in', async () => {
    stubLanguageSearch(['en', 'ja', 'de'])
    render(<Editable card={{ ...CARD, set_code: 'lng', collector_number: '5' }} />)

    await userEvent.click(screen.getByRole('button', { name: 'English' }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Japanese/ })).toBeTruthy())
    expect(screen.getByRole('button', { name: /German/ })).toBeTruthy()
    // Present in LANG_NAMES_FULL, but this printing has no such version.
    expect(screen.queryByRole('button', { name: /Phyrexian/ })).toBe(null)
  })

  it('keeps the stored language selectable even when Scryfall omits it', async () => {
    stubLanguageSearch(['en', 'ja'])
    render(<Editable card={{ ...CARD, set_code: 'lng', collector_number: '6', language: 'la' }} />)

    await userEvent.click(screen.getByRole('button', { name: 'Latin' }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Japanese/ })).toBeTruthy())
    // Trigger + option: the stored value survives in the list Scryfall didn't report.
    expect(screen.getAllByRole('button', { name: /Latin/ }).length).toBe(2)
  })

  it('falls back to the full language list when the lookup fails', async () => {
    // Default beforeEach fetch stub returns { ok: false } for every request.
    render(<Editable card={{ ...CARD, set_code: 'lng', collector_number: '7' }} />)

    await userEvent.click(screen.getByRole('button', { name: 'English' }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Phyrexian/ })).toBeTruthy())
  })

  it('commits the buy price on blur, and skips the write when unchanged', async () => {
    const { putCards } = await import('../lib/db')
    render(<Editable card={{ ...CARD, set_code: 'lng', collector_number: '8' }} />)

    const input = document.querySelector('[name="card-detail-buy-price"]')
    await userEvent.click(input)
    await userEvent.click(document.body)
    expect(putCards).not.toHaveBeenCalled()  // blurred without editing

    await userEvent.type(input, '12.5')
    await userEvent.click(document.body)
    await waitFor(() => expect(putCards).toHaveBeenCalledWith([
      expect.objectContaining({ purchase_price: 12.5 }),
    ]))
  })
})
