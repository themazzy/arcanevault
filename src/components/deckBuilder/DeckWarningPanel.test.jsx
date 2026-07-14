// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DeckWarningPanel from './DeckWarningPanel'

afterEach(cleanup)

const WARNINGS = [
  {
    key: 'color:card-1',
    level: 'error',
    summary: 'Off-color card',
    detail: 'This card is outside the commander color identity.',
    targetCardId: 'card-1',
  },
  {
    key: 'size-under',
    level: 'error',
    summary: 'Deck needs more cards',
  },
]

function WarningPanelHarness({ onRevealTarget }) {
  const [open, setOpen] = useState(false)
  return (
    <DeckWarningPanel
      warnings={WARNINGS}
      deckCards={[{ id: 'card-1', name: 'Hybrid Test Card' }]}
      open={open}
      onToggle={() => setOpen(value => !value)}
      onRevealTarget={onRevealTarget}
    />
  )
}

describe('DeckWarningPanel', () => {
  it('opens and closes from the warning badge', async () => {
    const user = userEvent.setup()
    render(<WarningPanelHarness onRevealTarget={vi.fn()} />)

    const badge = screen.getByRole('button', { name: /2 warnings.*show warning details/i })
    expect(badge.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Deck warning details' })).toBe(null)

    await user.click(badge)
    expect(badge.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('region', { name: 'Deck warning details' })).toBeTruthy()

    await user.click(badge)
    expect(screen.queryByRole('region', { name: 'Deck warning details' })).toBe(null)
  })

  it('reveals the affected card without closing the issues panel', async () => {
    const user = userEvent.setup()
    const onRevealTarget = vi.fn()
    render(<WarningPanelHarness onRevealTarget={onRevealTarget} />)

    await user.click(screen.getByRole('button', { name: /review issues/i }))
    await user.click(screen.getByRole('button', { name: /off-color card/i }))

    expect(onRevealTarget).toHaveBeenCalledOnce()
    expect(onRevealTarget).toHaveBeenCalledWith('card-1')
    expect(screen.getByRole('region', { name: 'Deck warning details' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /hide issues/i })).toBeTruthy()
  })

  it('renders deck-wide issues as information rather than navigation actions', async () => {
    const user = userEvent.setup()
    render(<WarningPanelHarness onRevealTarget={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /review issues/i }))

    expect(screen.getByText('Deck needs more cards')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /deck needs more cards/i })).toBe(null)
  })

  it('does not render when there are no active warnings', () => {
    const { container } = render(
      <DeckWarningPanel warnings={[]} deckCards={[]} open={false} />,
    )
    expect(container.innerHTML).toBe('')
  })
})
