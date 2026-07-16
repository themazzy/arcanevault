import { describe, it, expect } from 'vitest'
import {
  BATTLEFIELD_GRID_SIZE,
  BATTLEFIELD_GRID_OFFSET,
  computeBattlefieldPlacement,
  snapToBattlefieldGrid,
} from './playtestGrid'

const onLattice = value => (value - BATTLEFIELD_GRID_OFFSET) % BATTLEFIELD_GRID_SIZE === 0

describe('snapToBattlefieldGrid', () => {
  it('snaps to the nearest dot centre', () => {
    expect(snapToBattlefieldGrid(11, 500)).toBe(11)
    expect(snapToBattlefieldGrid(14, 500)).toBe(11)
    expect(snapToBattlefieldGrid(21, 500)).toBe(11)
    expect(snapToBattlefieldGrid(23, 500)).toBe(33)
    expect(snapToBattlefieldGrid(100, 500)).toBe(99)
  })

  it('never moves a card more than half a grid step', () => {
    for (let value = 0; value <= 300; value += 1) {
      expect(Math.abs(snapToBattlefieldGrid(value, 500) - value)).toBeLessThanOrEqual(BATTLEFIELD_GRID_SIZE / 2)
    }
  })

  it('stays on the lattice when snapping past either edge', () => {
    // Below the first dot: rounds to 11, not off-lattice 0.
    expect(snapToBattlefieldGrid(-40, 500)).toBe(11)
    // Past the limit: steps back a full grid rather than clamping to the limit.
    const nearEdge = snapToBattlefieldGrid(495, 100)
    expect(nearEdge).toBe(99)
    expect(onLattice(nearEdge)).toBe(true)
  })

  it('clamps into range when the body is smaller than one grid step', () => {
    expect(snapToBattlefieldGrid(50, 4)).toBeLessThanOrEqual(4)
    expect(snapToBattlefieldGrid(50, 4)).toBeGreaterThanOrEqual(0)
    expect(snapToBattlefieldGrid(50, -20)).toBe(0)
  })
})

describe('computeBattlefieldPlacement', () => {
  it('snaps both axes and keeps the card inside the battlefield', () => {
    expect(computeBattlefieldPlacement({ x: 30, y: 47, bodyWidth: 800, bodyHeight: 600 }))
      .toEqual({ x: 33, y: 55 })
  })

  it('keeps a card dropped past the right/bottom edge fully visible', () => {
    const { x, y } = computeBattlefieldPlacement({ x: 900, y: 900, bodyWidth: 800, bodyHeight: 600 })
    expect(x).toBeLessThanOrEqual(800 - 116)
    expect(y).toBeLessThanOrEqual(600 - 164)
    expect(onLattice(x)).toBe(true)
    expect(onLattice(y)).toBe(true)
  })
})
