// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BracketBadge from './BracketBadge'
import styles from './BracketBadge.module.css'

const analysis = {
  bracket: 2,
  reasons: [],
  gameChangers: [],
  massLandDenial: [],
  extraTurns: [],
  twoCardCombos: [],
  tutors: [],
  fastMana: [],
  combosChecked: false,
}

afterEach(cleanup)

describe('BracketBadge', () => {
  it('runs the combo check without forwarding the click event as a deck override', () => {
    const onCheck = vi.fn()
    render(
      <BracketBadge
        analysis={analysis}
        bracket={2}
        combos={{ fetched: false, loading: false, onCheck }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /core/i }))
    fireEvent.click(screen.getByRole('button', { name: /run combo check/i }))

    expect(onCheck).toHaveBeenCalledOnce()
    expect(onCheck).toHaveBeenCalledWith()
  })

  it.each([
    [[], 'No combos found.', 'comboCheckEmpty'],
    [[['Card A', 'Card B']], 'Found 1 combo.', 'comboCheckSuccess'],
    [[['Card A', 'Card B'], ['Card C', 'Card D']], 'Found 2 combos.', 'comboCheckSuccess'],
  ])('keeps the check button visible and reports the result for %j', (nameLists, message, toneClass) => {
    const onCheck = vi.fn()
    render(
      <BracketBadge
        analysis={{ ...analysis, combosChecked: true }}
        bracket={2}
        combos={{ fetched: true, loading: false, nameLists, onCheck }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /core/i }))
    const status = screen.getByRole('status')
    expect(status.textContent).toBe(message)
    expect(status.classList.contains(styles[toneClass])).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Recheck combos' }))
    expect(onCheck).toHaveBeenCalledOnce()
    expect(onCheck).toHaveBeenCalledWith()
  })

  it('keeps the popover open after setting or resetting a manual bracket', () => {
    const onOverride = vi.fn()
    const { rerender } = render(
      <BracketBadge
        analysis={analysis}
        bracket={2}
        isOverridden={false}
        onOverride={onOverride}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /core/i }))
    fireEvent.click(screen.getByTitle('Optimized'))
    expect(onOverride).toHaveBeenLastCalledWith(4)
    expect(screen.getByText('Set manually')).toBeTruthy()

    rerender(
      <BracketBadge
        analysis={analysis}
        bracket={4}
        isOverridden
        onOverride={onOverride}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reset to auto' }))
    expect(onOverride).toHaveBeenLastCalledWith(null)
    expect(screen.getByText('Set manually')).toBeTruthy()
  })
})
