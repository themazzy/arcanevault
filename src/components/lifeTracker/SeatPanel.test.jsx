// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SeatPanel from './SeatPanel'
import { createGame, gameReducer } from '../../lib/lifeGame'

afterEach(() => { cleanup(); vi.useRealTimers() })

const player = (over = {}) => ({
  id: 0, name: 'Jan', color: '#d94f4f', artUrl: null, deckId: null, deckName: null,
  userId: null, life: 40, hasPartner: false, tax: [0, 0], dmg: {},
  counters: { poison: 0, energy: 0, experience: 0 },
  ...over,
})

const opponents = [
  { id: 1, name: 'Ada', color: '#3d8fd9', hasPartner: false },
  { id: 2, name: 'Lee', color: '#4fae63', hasPartner: false },
]

function setup(over = {}, props = {}) {
  const onLife = vi.fn()
  const onOpenSeat = vi.fn()
  const onOpenDamage = vi.fn()
  const utils = render(
    <SeatPanel
      player={player(over)}
      opponents={opponents}
      rotation={0}
      area="a"
      commander
      dead={false}
      onLife={onLife}
      onOpenSeat={onOpenSeat}
      onOpenDamage={onOpenDamage}
      {...props}
    />,
  )
  return { onLife, onOpenSeat, onOpenDamage, ...utils }
}

const lowerHalf = () => screen.getByRole('button', { name: /lose life/i })
const raiseHalf = () => screen.getByRole('button', { name: /gain life/i })

describe('rendering', () => {
  it('shows the life total and the seat name', () => {
    setup()
    expect(screen.getByText('40')).toBeTruthy()
    expect(screen.getByText('Jan')).toBeTruthy()
  })

  it('exposes the life total to assistive tech as a live region', () => {
    setup({ life: 33 })
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-label')).toBe('Jan: 33 life')
  })

  it('labels both halves by what they do and who they belong to', () => {
    setup()
    expect(lowerHalf()).toBeTruthy()
    expect(raiseHalf()).toBeTruthy()
  })
})

describe('split tap', () => {
  it('removes one life when the left half is pressed', () => {
    const { onLife } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 0, pointerId: 1 })
    expect(onLife).toHaveBeenCalledTimes(1)
    expect(onLife).toHaveBeenCalledWith(-1)
  })

  it('adds one life when the right half is pressed', () => {
    const { onLife } = setup()
    fireEvent.pointerDown(raiseHalf(), { button: 0, pointerId: 1 })
    expect(onLife).toHaveBeenCalledWith(1)
  })

  it('fires on press rather than waiting for release', () => {
    const { onLife } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 0, pointerId: 1 })
    expect(onLife).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(lowerHalf(), { pointerId: 1 })
    // Release must not double-apply the step.
    expect(onLife).toHaveBeenCalledTimes(1)
  })

  it('ignores non-primary mouse buttons', () => {
    const { onLife } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 2, pointerId: 1 })
    expect(onLife).not.toHaveBeenCalled()
  })

  it('applies exactly one step for a keyboard activation', () => {
    const { onLife } = setup()
    // A button activated by Enter/Space fires click with detail 0 and no pointerdown.
    fireEvent.click(lowerHalf(), { detail: 0 })
    expect(onLife).toHaveBeenCalledTimes(1)
    expect(onLife).toHaveBeenCalledWith(-1)
  })

  it('does not double-apply when a pointer press also produces a click', () => {
    const { onLife } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 0, pointerId: 1 })
    fireEvent.pointerUp(lowerHalf(), { pointerId: 1 })
    fireEvent.click(lowerHalf(), { detail: 1 })
    expect(onLife).toHaveBeenCalledTimes(1)
  })
})

describe('hold to ramp', () => {
  it('does nothing extra for a short tap', () => {
    vi.useFakeTimers()
    const { onLife } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 0, pointerId: 1 })
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.pointerUp(lowerHalf(), { pointerId: 1 })
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onLife).toHaveBeenCalledTimes(1)
  })

  it('repeats while held, then accelerates', () => {
    vi.useFakeTimers()
    const { onLife } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 0, pointerId: 1 })
    act(() => { vi.advanceTimersByTime(420 + 130 * 4) })
    const early = onLife.mock.calls.length
    expect(early).toBeGreaterThan(2)
    expect(onLife.mock.calls.every(([d]) => d === -1)).toBe(true)

    // Held long enough to reach the ×5 tier.
    act(() => { vi.advanceTimersByTime(130 * 8) })
    expect(onLife.mock.calls.some(([d]) => d === -5)).toBe(true)

    fireEvent.pointerUp(lowerHalf(), { pointerId: 1 })
    const afterRelease = onLife.mock.calls.length
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onLife).toHaveBeenCalledTimes(afterRelease)
  })

  it('stops repeating if the pointer is cancelled or capture is lost', () => {
    vi.useFakeTimers()
    const { onLife } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 0, pointerId: 1 })
    act(() => { vi.advanceTimersByTime(420 + 130 * 3) })
    const held = onLife.mock.calls.length
    fireEvent.pointerCancel(lowerHalf(), { pointerId: 1 })
    act(() => { vi.advanceTimersByTime(1500) })
    expect(onLife).toHaveBeenCalledTimes(held)
  })

  it('does not keep firing after unmount', () => {
    vi.useFakeTimers()
    const { onLife, unmount } = setup()
    fireEvent.pointerDown(lowerHalf(), { button: 0, pointerId: 1 })
    act(() => { vi.advanceTimersByTime(420 + 130 * 2) })
    const held = onLife.mock.calls.length
    unmount()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onLife).toHaveBeenCalledTimes(held)
  })
})

describe('running total', () => {
  it('shows the net change across a burst and clears it after the linger', () => {
    vi.useFakeTimers()
    const { rerender } = setup({ life: 40 })
    expect(screen.queryByText('-3')).toBeNull()

    const render3 = (life) => rerender(
      <SeatPanel
        player={player({ life })} opponents={opponents} rotation={0} area="a"
        commander dead={false} onLife={vi.fn()} onOpenSeat={vi.fn()} onOpenDamage={vi.fn()}
      />,
    )

    act(() => { render3(37) })
    expect(screen.getByText('-3')).toBeTruthy()

    act(() => { render3(35) })
    expect(screen.getByText('-5')).toBeTruthy()

    act(() => { vi.advanceTimersByTime(1700) })
    expect(screen.queryByText('-5')).toBeNull()
  })
})

describe('status', () => {
  it('marks a dead seat as out rather than covering it with an overlay', () => {
    setup({ life: 0 }, { dead: true })
    expect(screen.getByText('Out')).toBeTruthy()
    // The life total stays readable — the point of a dead seat is still its number.
    // Scoped to the live region, since zero-damage pips also render "0".
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Jan: 0 life')
  })

  it('shows the death flavour line under the total, not over it', () => {
    setup({ life: 0 }, { dead: true, deathText: 'Split in half by Garruk' })
    expect(screen.getByText('Split in half by Garruk')).toBeTruthy()
    // The total is still readable — that was the problem with the old overlay.
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Jan: 0 life')
  })

  it('does not show flavour text for a living player', () => {
    setup({ life: 40 }, { dead: false, deathText: 'Split in half by Garruk' })
    expect(screen.queryByText('Split in half by Garruk')).toBeNull()
  })

  it('shows only counters that are actually set', () => {
    setup({ counters: { poison: 4, energy: 0, experience: 0 } })
    expect(screen.getByText(/PSN\s*4/)).toBeTruthy()
    expect(screen.queryByText(/NRG/)).toBeNull()
  })

  it('flags lethal poison', () => {
    setup({ counters: { poison: 10, energy: 0, experience: 0 } })
    expect(screen.getByText('Poisoned')).toBeTruthy()
  })

  it('shows commander tax only when it has been paid', () => {
    const { rerender } = setup({ tax: [0, 0] })
    expect(screen.queryByText(/Tax/)).toBeNull()
    rerender(
      <SeatPanel
        player={player({ tax: [2, 0] })} opponents={opponents} rotation={0} area="a"
        commander dead={false} onLife={vi.fn()} onOpenSeat={vi.fn()} onOpenDamage={vi.fn()}
      />,
    )
    expect(screen.getByText(/Tax\s*2/)).toBeTruthy()
  })
})

describe('commander damage rail', () => {
  it('shows one pip per opponent and opens the damage sheet', () => {
    const { onOpenDamage } = setup({ dmg: { 1: [12, 0] } })
    const rail = screen.getByRole('button', { name: /commander damage dealt to jan/i })
    expect(rail.textContent).toContain('12')
    fireEvent.click(rail)
    expect(onOpenDamage).toHaveBeenCalledTimes(1)
  })

  it('sums a partner pair into one pip', () => {
    setup({ dmg: { 1: [8, 5] } })
    const rail = screen.getByRole('button', { name: /commander damage dealt to jan/i })
    expect(rail.textContent).toContain('13')
  })

  it('is hidden outside commander formats', () => {
    setup({}, { commander: false })
    expect(screen.queryByRole('button', { name: /commander damage/i })).toBeNull()
  })
})

describe('seat sheet', () => {
  it('opens from the name row, which is why the name is not edited on the panel', () => {
    const { onOpenSeat } = setup()
    fireEvent.click(screen.getByRole('button', { name: /edit jan/i }))
    expect(onOpenSeat).toHaveBeenCalledTimes(1)
  })
})

describe('integration with the reducer', () => {
  it('a press-driven delta lands on the right seat', () => {
    let game = createGame({ format: 'commander', seatCount: 4 })
    const onLife = delta => { game = gameReducer(game, { type: 'life', id: 1, delta, ts: 1 }) }
    render(
      <SeatPanel
        player={game.players[1]} opponents={opponents} rotation={0} area="b"
        commander dead={false} onLife={onLife} onOpenSeat={vi.fn()} onOpenDamage={vi.fn()}
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: /lose life/i }), { button: 0, pointerId: 1 })
    expect(game.players.map(p => p.life)).toEqual([40, 39, 40, 40])
  })
})
