// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/db', () => ({
  getLocalCards: vi.fn(async () => []),
  getLocalCardPrints: vi.fn(async () => []),
}))

vi.mock('../../lib/scryfall', () => ({
  getInstantCache: vi.fn(async () => ({})),
  getScryfallKey: p => `${p?.set_code}-${p?.collector_number}`,
  getImageUri: c => c?.image_uris?.normal || null,
}))

vi.mock('../../lib/deckBuilderApi', () => ({
  searchCommanders: vi.fn(async () => []),
  searchLegalPartners: vi.fn(async () => []),
  fetchCardsByScryfallIds: vi.fn(async () => []),
  fetchRandomCommander: vi.fn(async () => null),
  fetchRandomPartner: vi.fn(async () => null),
}))

vi.mock('../../lib/deckBuilderHelpers', () => ({ manaSymbolUrl: () => 'sym.svg' }))

import { GuidedCommanderPicker } from './GuidedCommanderPicker'
import { getLocalCards, getLocalCardPrints } from '../../lib/db'
import {
  fetchCardsByScryfallIds, fetchRandomCommander, fetchRandomPartner,
} from '../../lib/deckBuilderApi'

afterEach(cleanup)

const KRENKO = {
  id: 'sf-krenko',
  name: 'Krenko, Mob Boss',
  type_line: 'Legendary Creature — Goblin Warrior',
  oracle_text: '{T}: Create X 1/1 red Goblin creature tokens.',
  color_identity: ['R'],
}

const TYMNA = {
  id: 'sf-tymna',
  name: 'Tymna the Weaver',
  type_line: 'Legendary Creature — Human Cleric',
  oracle_text: 'Partner (You can have two commanders if both have partner.)',
  color_identity: ['W', 'B'],
}

const THRASIOS = {
  id: 'sf-thrasios',
  name: 'Thrasios, Triton Hero',
  type_line: 'Legendary Creature — Merfolk Wizard',
  oracle_text: 'Partner',
  color_identity: ['G', 'U'],
}

// Mirrors Builder.jsx: the parent owns both commander and partner, and the
// partner-clearing effect inside the picker fires off the commander change.
function Host() {
  const [cmd, setCmd] = useState(null)
  const [partner, setPartner] = useState(null)
  const onSelect = useCallback(sf => setCmd(sf), [])
  return (
    <>
      <GuidedCommanderPicker
        userId="u1"
        value={cmd}
        onSelect={onSelect}
        partnerValue={partner}
        onSelectPartner={setPartner}
      />
      <output data-testid="cmd">{cmd?.name || ''}</output>
      <output data-testid="partner">{partner?.name || ''}</output>
    </>
  )
}

// One owned legendary in the collection, stored as print metadata only (the
// cold-Scryfall-cache shape the owned list is normally built from).
function seedOwnedKrenko() {
  getLocalCards.mockResolvedValue([{ id: 'card-1', card_print_id: 'p1' }])
  getLocalCardPrints.mockResolvedValue([{
    id: 'p1',
    scryfall_id: 'sf-krenko',
    name: 'Krenko, Mob Boss',
    type_line: 'Legendary Creature — Goblin Warrior',
    set_code: '2xm',
    collector_number: '1',
    color_identity: ['R'],
  }])
}

describe('GuidedCommanderPicker random roll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLocalCards.mockResolvedValue([])
    getLocalCardPrints.mockResolvedValue([])
    fetchCardsByScryfallIds.mockResolvedValue([])
    fetchRandomCommander.mockResolvedValue(null)
    fetchRandomPartner.mockResolvedValue(null)
  })

  it('rolls a random commander from the collection without hitting Scryfall random', async () => {
    seedOwnedKrenko()
    // Owned rows carry no oracle text, so the roll fills the card in first.
    fetchCardsByScryfallIds.mockResolvedValue([KRENKO])
    const user = userEvent.setup()
    render(<Host />)

    const btn = await screen.findByRole('button', { name: /Random from collection/ })
    await waitFor(() => expect(btn.disabled).toBe(false))
    await user.click(btn)

    await waitFor(() => expect(screen.getByTestId('cmd').textContent).toBe('Krenko, Mob Boss'))
    expect(fetchRandomCommander).not.toHaveBeenCalled()
  })

  it('disables the collection dice when the user owns no commanders', async () => {
    render(<Host />)
    const btn = await screen.findByRole('button', { name: /Random from collection/ })
    await waitFor(() => expect(btn.disabled).toBe(true))
  })

  it('rolls any commander and keeps the partner it rolled with it', async () => {
    fetchRandomCommander.mockResolvedValue(TYMNA)
    fetchRandomPartner.mockResolvedValue(THRASIOS)
    const user = userEvent.setup()
    render(<Host />)

    await user.click(await screen.findByRole('button', { name: /Random commander/ }))

    await waitFor(() => expect(screen.getByTestId('cmd').textContent).toBe('Tymna the Weaver'))
    expect(fetchRandomPartner).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'partner' }),
      'Tymna the Weaver',
    )
    // The regression this guards: the picker clears the partner whenever the
    // commander changes, which would wipe the partner the same roll just chose.
    await waitFor(() => expect(screen.getByTestId('partner').textContent).toBe('Thrasios, Triton Hero'))
    expect(screen.getByTestId('partner').textContent).toBe('Thrasios, Triton Hero')
  })

  it('does not look for a partner when the rolled commander has no partner ability', async () => {
    fetchRandomCommander.mockResolvedValue(KRENKO)
    const user = userEvent.setup()
    render(<Host />)

    await user.click(await screen.findByRole('button', { name: /Random commander/ }))

    await waitFor(() => expect(screen.getByTestId('cmd').textContent).toBe('Krenko, Mob Boss'))
    expect(fetchRandomPartner).not.toHaveBeenCalled()
  })

  it('clears a rolled partner once a different commander is picked by hand', async () => {
    seedOwnedKrenko()
    fetchCardsByScryfallIds.mockResolvedValue([KRENKO])
    fetchRandomCommander.mockResolvedValue(TYMNA)
    fetchRandomPartner.mockResolvedValue(THRASIOS)
    const user = userEvent.setup()
    render(<Host />)

    await user.click(await screen.findByRole('button', { name: /Random commander/ }))
    await waitFor(() => expect(screen.getByTestId('partner').textContent).toBe('Thrasios, Triton Hero'))

    await user.click(screen.getByRole('button', { name: /Krenko, Mob Boss/ }))

    await waitFor(() => expect(screen.getByTestId('cmd').textContent).toBe('Krenko, Mob Boss'))
    expect(screen.getByTestId('partner').textContent).toBe('')
  })
})
