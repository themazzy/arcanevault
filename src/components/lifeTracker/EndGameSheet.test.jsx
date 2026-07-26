// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EndGameSheet from './EndGameSheet'

afterEach(cleanup)

const PLAYERS = [
  { id: 0, name: 'Player 1', color: '#d94f4f', life: 12, deckId: 'd1', deckName: 'Atraxa', dmg: {}, counters: { poison: 0 } },
  { id: 1, name: 'Player 2', color: '#3d8fd9', life: 0, deckId: null, deckName: null, dmg: {}, counters: { poison: 0 } },
]

function setup(props = {}) {
  const onSave = vi.fn()
  const onDiscard = vi.fn()
  const onClose = vi.fn()
  render(
    <EndGameSheet
      players={PLAYERS}
      saving={false}
      error=""
      onSave={onSave}
      onDiscard={onDiscard}
      onClose={onClose}
      {...props}
    />,
  )
  return { onSave, onDiscard, onClose }
}

const discardBtn = () => screen.queryByRole('button', { name: /discard without saving/i })

describe('EndGameSheet discard', () => {
  // Discarding used to live in the table's game menu; it belongs beside saving
  // the result, since both are ways the game ends.
  it('offers discarding alongside the result controls', () => {
    setup()
    expect(discardBtn()).not.toBe(null)
    expect(screen.getByRole('button', { name: /save result/i })).not.toBe(null)
  })

  it('hands the discard back to the caller to confirm', () => {
    const { onDiscard, onSave, onClose } = setup()
    fireEvent.click(discardBtn())
    expect(onDiscard).toHaveBeenCalledTimes(1)
    // Discarding is not a save, and it must not be mistaken for dismissing the
    // sheet — the caller decides what happens next.
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('locks the discard while a save is in flight', () => {
    setup({ saving: true })
    expect(discardBtn().disabled).toBe(true)
  })

  it('omits the discard entirely when no handler is given', () => {
    setup({ onDiscard: undefined })
    expect(discardBtn()).toBe(null)
  })
})
