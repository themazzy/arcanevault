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

  describe('prev/next stepper', () => {
    const navProps = { navIndex: 1, navTotal: 4, onNavigate: vi.fn() }

    it('shows the position and steps in both directions', async () => {
      const onNavigate = vi.fn()
      render(<Detail card={CARD} {...navProps} onNavigate={onNavigate} />)

      expect(screen.getByText('2 / 4')).toBeTruthy()

      await userEvent.click(screen.getByRole('button', { name: 'Next card' }))
      expect(onNavigate).toHaveBeenCalledWith(1)

      await userEvent.click(screen.getByRole('button', { name: 'Previous card' }))
      expect(onNavigate).toHaveBeenLastCalledWith(-1)
    })

    it('disables the button at each end of the list instead of wrapping', () => {
      const { rerender } = render(<Detail card={CARD} {...navProps} navIndex={0} />)
      expect(screen.getByRole('button', { name: 'Previous card (←)' }).disabled).toBe(true)
      expect(screen.getByRole('button', { name: 'Next card (→)' }).disabled).toBe(false)
      // The gutter aside for a card that isn't there drops out of the
      // accessibility tree entirely rather than announcing a dead control.
      expect(screen.queryByRole('button', { name: 'Previous card' })).toBe(null)

      rerender(<Detail card={CARD} {...navProps} navIndex={3} />)
      expect(screen.getByRole('button', { name: 'Previous card (←)' }).disabled).toBe(false)
      expect(screen.getByRole('button', { name: 'Next card (→)' }).disabled).toBe(true)
      expect(screen.queryByRole('button', { name: 'Next card' })).toBe(null)
    })

    it('hides the stepper without onNavigate, for a lone card, or off-list', () => {
      const { rerender } = render(<Detail card={CARD} navIndex={1} navTotal={4} />)
      expect(screen.queryByRole('button', { name: 'Next card' })).toBe(null)

      rerender(<Detail card={CARD} {...navProps} navIndex={0} navTotal={1} />)
      expect(screen.queryByRole('button', { name: 'Next card' })).toBe(null)

      rerender(<Detail card={CARD} {...navProps} navIndex={-1} />)
      expect(screen.queryByRole('button', { name: 'Next card' })).toBe(null)
    })

    it('renders the gutter asides with the neighbouring cards art', async () => {
      const onNavigate = vi.fn()
      render(
        <Detail
          card={CARD}
          navIndex={1}
          navTotal={4}
          onNavigate={onNavigate}
          navPrev={{ name: 'Before Card', image: 'https://img/before.jpg' }}
          navNext={{ name: 'After Card', image: 'https://img/after.jpg' }}
        />
      )

      const nextAside = screen.getByRole('button', { name: 'Next card: After Card' })
      expect(screen.getByRole('button', { name: 'Previous card: Before Card' })).toBeTruthy()
      expect(document.querySelector('img[src="https://img/after.jpg"]')).toBeTruthy()

      await userEvent.click(nextAside)
      expect(onNavigate).toHaveBeenCalledWith(1)
    })

    it('navigates from the thumbnail, not just the pill under it', async () => {
      // The thumbnail changes on hover, so it has to be part of the control —
      // a preview that reacts to the pointer but ignores clicks reads as broken.
      const onNavigate = vi.fn()
      render(
        <Detail
          card={CARD}
          navIndex={1}
          navTotal={4}
          onNavigate={onNavigate}
          navNext={{ name: 'After Card', image: 'https://img/after.jpg' }}
        />
      )

      await userEvent.click(document.querySelector('img[src="https://img/after.jpg"]'))
      expect(onNavigate).toHaveBeenCalledWith(1)
    })

    it('keeps the asides usable when a neighbour has no preview image', () => {
      render(<Detail card={CARD} {...navProps} />)
      // No navPrev/navNext supplied — no thumbnail, buttons still work.
      expect(screen.getByRole('button', { name: 'Previous card' }).disabled).toBe(false)
      expect(screen.getByRole('button', { name: 'Next card' }).disabled).toBe(false)
    })

    it('marks the direction of travel so the incoming card slides in from it', async () => {
      const { container } = render(<Detail card={CARD} {...navProps} />)
      const heroClass = () => container.querySelector('[class*="detailHero"]').className

      expect(heroClass()).not.toMatch(/detailHeroStep/)

      await userEvent.click(screen.getByRole('button', { name: 'Next card' }))
      expect(heroClass()).toMatch(/detailHeroStepNext/)

      await userEvent.click(screen.getByRole('button', { name: 'Previous card' }))
      expect(heroClass()).toMatch(/detailHeroStepPrev/)
    })

    it('steps with the arrow keys, but not while a field has focus', async () => {
      const onNavigate = vi.fn()
      render(
        <MemoryRouter>
          <CardDetail card={CARD} sfCard={SF_CARD} onClose={vi.fn()} onSave={vi.fn()}
            navIndex={1} navTotal={4} onNavigate={onNavigate} />
        </MemoryRouter>
      )

      await userEvent.keyboard('{ArrowRight}')
      expect(onNavigate).toHaveBeenCalledWith(1)
      await userEvent.keyboard('{ArrowLeft}')
      expect(onNavigate).toHaveBeenLastCalledWith(-1)

      // Editable surface: the arrow keys belong to the quantity field once it
      // has focus.
      onNavigate.mockClear()
      await userEvent.click(document.querySelector('[name="card-detail-quantity"]'))
      await userEvent.keyboard('{ArrowRight}')
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('re-derives the edit form when the card is swapped in place', async () => {
      const OTHER = { ...CARD, id: 'card-2', name: 'Second Card', qty: 7, condition: 'damaged' }
      const { rerender } = render(
        <MemoryRouter>
          <CardDetail card={CARD} sfCard={SF_CARD} onClose={vi.fn()} onSave={vi.fn()}
            navIndex={0} navTotal={2} onNavigate={vi.fn()} />
        </MemoryRouter>
      )
      expect(document.querySelector('[name="card-detail-quantity"]').value).toBe('1')

      // Stepping does not remount (the active tab survives), so the per-card
      // form state has to follow the new card.
      rerender(
        <MemoryRouter>
          <CardDetail card={OTHER} sfCard={SF_CARD} onClose={vi.fn()} onSave={vi.fn()}
            navIndex={1} navTotal={2} onNavigate={vi.fn()} />
        </MemoryRouter>
      )
      await waitFor(() => expect(document.querySelector('[name="card-detail-quantity"]').value).toBe('7'))
      expect(screen.getByRole('button', { name: 'Damaged' })).toBeTruthy()
    })
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
