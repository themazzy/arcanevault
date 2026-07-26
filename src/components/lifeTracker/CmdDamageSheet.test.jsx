// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CmdDamageSheet from './CmdDamageSheet'

afterEach(() => { cleanup(); vi.useRealTimers() })

const player = (over = {}) => ({
  id: 0, name: 'Player 3', color: '#4fae63', life: 29, hasPartner: false,
  tax: [0, 0], dmg: {}, counters: { poison: 0, energy: 0, experience: 0 },
  ...over,
})

const opponents = [
  { id: 1, name: 'Player 1', color: '#d94f4f', hasPartner: false },
  { id: 2, name: 'Player 2', color: '#3d8fd9', hasPartner: false },
  { id: 4, name: 'Player 4', color: '#e0b13c', hasPartner: true },
]

function setup(over = {}, props = {}) {
  const onDamage = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <CmdDamageSheet
      player={player(over)}
      opponents={opponents}
      rotation={0}
      onDamage={onDamage}
      onClose={onClose}
      {...props}
    />,
  )
  return { onDamage, onClose, ...utils }
}

describe('layout', () => {
  it('gives every commander its own control, partners included', () => {
    setup()
    // Three opponents, one of them partnered: four bars, not three.
    expect(screen.getAllByRole('button', { name: /^add damage from/i })).toHaveLength(4)
  })

  it('names each partner commander so the two cannot be confused', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Add damage from Player 4, first commander' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add damage from Player 4, second commander' })).toBeTruthy()
  })

  it('labels a lone commander without repeating the player name', () => {
    setup()
    expect(screen.getAllByText('Commander')).toHaveLength(2)
    expect(screen.getByText('First')).toBeTruthy()
    expect(screen.getByText('Second')).toBeTruthy()
  })
})

describe('stepping damage', () => {
  const pane = (name) => screen.getByRole('button', { name })

  it('routes each pane to its own commander slot', () => {
    const { onDamage } = setup({ dmg: { 4: [3, 8] } })
    fireEvent.pointerDown(pane('Add damage from Player 4, second commander'), { button: 0, pointerId: 1 })
    expect(onDamage).toHaveBeenCalledWith(4, 1, 1)

    fireEvent.pointerDown(pane('Remove damage from Player 4, first commander'), { button: 0, pointerId: 1 })
    expect(onDamage).toHaveBeenCalledWith(4, 0, -1)
  })

  it('applies on press rather than on release, like the seat panels', () => {
    const { onDamage } = setup({ dmg: { 1: [2, 0] } })
    fireEvent.pointerDown(pane('Add damage from Player 1'), { button: 0, pointerId: 1 })
    expect(onDamage).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(pane('Add damage from Player 1'), { pointerId: 1 })
    expect(onDamage).toHaveBeenCalledTimes(1)
  })

  it('repeats while held, at 1 a tick — a ramp would overshoot 21', () => {
    vi.useFakeTimers()
    const { onDamage } = setup({ dmg: { 1: [2, 0] } })
    fireEvent.pointerDown(pane('Add damage from Player 1'), { button: 0, pointerId: 1 })
    act(() => { vi.advanceTimersByTime(420 + 130 * 14) })
    expect(onDamage.mock.calls.length).toBeGreaterThan(10)
    expect(onDamage.mock.calls.every(([, , d]) => d === 1)).toBe(true)

    fireEvent.pointerUp(pane('Add damage from Player 1'), { pointerId: 1 })
    const held = onDamage.mock.calls.length
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onDamage).toHaveBeenCalledTimes(held)
  })

  it('is operable from the keyboard', () => {
    const { onDamage } = setup({ dmg: { 1: [2, 0] } })
    fireEvent.click(pane('Remove damage from Player 1'), { detail: 0 })
    expect(onDamage).toHaveBeenCalledWith(1, 0, -1)
  })

  it('cannot take damage below zero', () => {
    setup()
    expect(pane('Remove damage from Player 1').disabled).toBe(true)
  })

  it('flags a commander that has dealt lethal', () => {
    setup({ dmg: { 1: [21, 0] } })
    expect(screen.getByText('Lethal — 21 from one commander')).toBeTruthy()
    // The bar swaps its own label for the warning rather than adding a row.
    expect(screen.getAllByText('Lethal').length).toBeGreaterThan(0)
  })
})

describe('life readout', () => {
  it('shows the total being spent, since the sheet covers the seat', () => {
    setup({ life: 29 })
    expect(screen.getByText('29')).toBeTruthy()
    expect(screen.getByText('life')).toBeTruthy()
  })

  it('shows the running change and clears it after the linger', () => {
    vi.useFakeTimers()
    const { rerender } = setup({ life: 29 })
    expect(screen.queryByText('-3')).toBeNull()

    const atLife = (life) => rerender(
      <CmdDamageSheet
        player={player({ life })} opponents={opponents} rotation={0}
        onDamage={vi.fn()} onClose={vi.fn()}
      />,
    )

    act(() => { atLife(26) })
    expect(screen.getByText('-3')).toBeTruthy()

    act(() => { atLife(21) })
    expect(screen.getByText('-8')).toBeTruthy()

    act(() => { vi.advanceTimersByTime(2200) })
    expect(screen.queryByText('-8')).toBeNull()
  })
})
