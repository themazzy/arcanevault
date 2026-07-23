// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpecificCardSearch } from './SpecificCardSearch'

// Minimal legal cards — enough for getCardLegalityWarnings to run quietly.
const CARDS = [
  { id: 'c1', name: 'Sol Ring', color_identity: [], legalities: { commander: 'legal' } },
  { id: 'c2', name: 'Solemn Simulacrum', color_identity: [], legalities: { commander: 'legal' } },
  { id: 'c3', name: 'Soul Warden', color_identity: ['W'], legalities: { commander: 'legal' } },
]

function renderSearch(overrides = {}) {
  const onAdd = vi.fn()
  const props = {
    search: { query: 'sol', results: CARDS, loading: false, handleInput: vi.fn() },
    onAdd,
    isAdded: () => false,
    categoryOf: () => 'Ramp',
    commanderColorIdentity: ['W', 'U'],
    makePreview: () => ({}),
    imageOf: () => null,
    ...overrides,
  }
  const utils = render(<SpecificCardSearch {...props} />)
  return { ...utils, onAdd }
}

const openPopover = () => {
  const input = screen.getByRole('combobox')
  fireEvent.focus(input)
  return input
}

afterEach(cleanup)

describe('SpecificCardSearch keyboard flow', () => {
  it('shows the exact display price and winning finish from search', () => {
    renderSearch({
      priceSource: 'cardmarket_trend',
      search: {
        query: 'arcane',
        results: [{
          id: 'arcane-signet',
          name: 'Arcane Signet',
          color_identity: [],
          legalities: { commander: 'legal' },
          display_price: 0.28,
          display_finish: 'Foil',
        }],
        loading: false,
        handleInput: vi.fn(),
      },
    })

    openPopover()
    expect(screen.getByText(/€0\.28/).textContent).toContain('Foil')
  })

  it('opens on focus and highlights rows with ArrowDown/ArrowUp', () => {
    renderSearch()
    const input = openPopover()
    expect(screen.getByRole('listbox')).toBeTruthy()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    let options = screen.getAllByRole('option')
    expect(options[0].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    options = screen.getAllByRole('option')
    expect(options[1].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    options = screen.getAllByRole('option')
    expect(options[0].getAttribute('aria-selected')).toBe('true')
  })

  it('adds the highlighted card on Enter, and only then', () => {
    const { onAdd } = renderSearch()
    const input = openPopover()

    // Enter with no highlight must not add anything.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith(CARDS[1])
  })

  it('does not re-add an already-added highlight', () => {
    const { onAdd } = renderSearch({ isAdded: name => name === 'Sol Ring' })
    const input = openPopover()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('Escape closes only the popover (claims the modal stack)', () => {
    renderSearch()
    const input = openPopover()
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Tab closes the popover without trapping focus', () => {
    renderSearch()
    const input = openPopover()
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
