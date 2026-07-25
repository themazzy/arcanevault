// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import SwapArrow from './SwapArrow'

afterEach(cleanup)

const draw = (from, to) => render(<SwapArrow from={from} to={to} />).container
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
