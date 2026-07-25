// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// reduce_motion off by default; the snap-animation cases override it.
let reduceMotion = false
vi.mock('../SettingsContext', () => ({
  useSettings: () => ({ reduce_motion: reduceMotion }),
}))

const { default: SwapArrow, SNAP_MS } = await import('./SwapArrow')

afterEach(() => {
  cleanup()
  reduceMotion = false
  vi.useRealTimers()
  // Required, not tidiness: vi.spyOn on an already-spied method returns the same
  // spy with its recorded calls intact, so a later "was not called" assertion
  // would see the previous test's calls.
  vi.restoreAllMocks()
})

const draw = (from, to, snapped = false) =>
  render(<SwapArrow from={from} to={to} snapped={snapped} />).container
const lineOf = (container) => container.querySelectorAll('line')[1]  // [0] is the shadow

describe('SwapArrow', () => {
  it('draws nothing without both endpoints', () => {
    expect(draw(null, { x: 10, y: 10 }).querySelector('svg')).toBeNull()
    expect(draw({ x: 10, y: 10 }, null).querySelector('svg')).toBeNull()
    expect(draw(undefined, undefined).querySelector('svg')).toBeNull()
  })

  it('draws nothing for a drag too short to read', () => {
    expect(draw({ x: 100, y: 100 }, { x: 110, y: 100 }).querySelector('svg')).toBeNull()
  })

  it('draws once the drag is long enough', () => {
    const container = draw({ x: 0, y: 0 }, { x: 300, y: 0 })
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelectorAll('line')).toHaveLength(2)  // shadow + line
  })

  it('points from the origin toward the target', () => {
    const line = lineOf(draw({ x: 0, y: 0 }, { x: 300, y: 0 }))
    const x1 = Number(line.getAttribute('x1'))
    const x2 = Number(line.getAttribute('x2'))
    expect(x2).toBeGreaterThan(x1)
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(0)
  })

  it('insets both ends so the head clears the seat borders', () => {
    const line = lineOf(draw({ x: 0, y: 0 }, { x: 300, y: 0 }))
    expect(Number(line.getAttribute('x1'))).toBeCloseTo(15)
    expect(Number(line.getAttribute('x2'))).toBeCloseTo(285)
  })

  it('insets along the diagonal, not per-axis', () => {
    // A 3-4-5 triangle scaled up: the inset must follow the line's direction.
    const line = lineOf(draw({ x: 0, y: 0 }, { x: 300, y: 400 }))
    const dx = Number(line.getAttribute('x1'))
    const dy = Number(line.getAttribute('y1'))
    expect(Math.hypot(dx, dy)).toBeCloseTo(15)
  })

  it('marks the seat it came from and carries an arrow head', () => {
    const container = draw({ x: 0, y: 0 }, { x: 300, y: 0 })
    expect(container.querySelector('circle')).toBeTruthy()
    expect(lineOf(container).getAttribute('marker-end')).toBe('url(#lt-swap-head)')
    expect(container.querySelector('marker#lt-swap-head')).toBeTruthy()
  })

  it('stays out of the way of pointers and screen readers', () => {
    const svg = draw({ x: 0, y: 0 }, { x: 300, y: 0 }).querySelector('svg')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('survives degenerate coordinates', () => {
    expect(draw({ x: 0, y: 0 }, { x: 0, y: 0 }).querySelector('svg')).toBeNull()
    expect(draw({ x: NaN, y: 0 }, { x: 300, y: 0 }).querySelector('svg')).toBeNull()
  })
})

describe('snapping', () => {
  it('marks the line while locked onto a seat', () => {
    const snapped = lineOf(draw({ x: 0, y: 0 }, { x: 300, y: 0 }, true))
    expect(snapped.getAttribute('data-snapped')).toBe('true')
    const free = lineOf(draw({ x: 0, y: 0 }, { x: 300, y: 0 }, false))
    expect(free.getAttribute('data-snapped')).toBeNull()
  })

  it('follows the finger with no interpolation while unsnapped', () => {
    const { container, rerender } = render(
      <SwapArrow from={{ x: 0, y: 0 }} to={{ x: 200, y: 0 }} snapped={false} />,
    )
    rerender(<SwapArrow from={{ x: 0, y: 0 }} to={{ x: 400, y: 0 }} snapped={false} />)
    // Lands immediately: a lagging arrow would trail the thing it is attached to.
    expect(Number(lineOf(container).getAttribute('x2'))).toBeCloseTo(385)
  })

  it('eases into a snap and settles within the 100ms budget', () => {
    const raf = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => {
      raf.push(cb); return raf.length
    })
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    const { container, rerender } = render(
      <SwapArrow from={{ x: 0, y: 0 }} to={{ x: 200, y: 0 }} snapped={false} />,
    )
    // Finger crosses into a seat whose centre is further along.
    rerender(<SwapArrow from={{ x: 0, y: 0 }} to={{ x: 400, y: 0 }} snapped />)

    const drain = (at) => {
      now = at
      const pending = raf.splice(0, raf.length)
      act(() => { pending.forEach(cb => cb(at)) })
    }

    drain(1000 + SNAP_MS / 2)
    const mid = Number(lineOf(container).getAttribute('x2'))
    // Part way there, not jumped.
    expect(mid).toBeGreaterThan(185)
    expect(mid).toBeLessThan(385)

    drain(1000 + SNAP_MS)
    expect(Number(lineOf(container).getAttribute('x2'))).toBeCloseTo(385)
    expect(raf).toHaveLength(0)   // loop stopped
  })

  it('jumps straight to the target under reduce_motion', () => {
    reduceMotion = true
    const raf = vi.spyOn(window, 'requestAnimationFrame')

    const { container, rerender } = render(
      <SwapArrow from={{ x: 0, y: 0 }} to={{ x: 200, y: 0 }} snapped={false} />,
    )
    rerender(<SwapArrow from={{ x: 0, y: 0 }} to={{ x: 400, y: 0 }} snapped />)

    expect(Number(lineOf(container).getAttribute('x2'))).toBeCloseTo(385)
    expect(raf).not.toHaveBeenCalled()
  })

  it('cancels its animation frame on unmount', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7)
    const { rerender, unmount } = render(
      <SwapArrow from={{ x: 0, y: 0 }} to={{ x: 200, y: 0 }} snapped={false} />,
    )
    rerender(<SwapArrow from={{ x: 0, y: 0 }} to={{ x: 400, y: 0 }} snapped />)
    unmount()
    expect(cancel).toHaveBeenCalled()
  })
})
