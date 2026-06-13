import { describe, it, expect } from 'vitest'
import { isPlayerDead } from './LifeTracker'

const player = (over = {}) => ({
  life: 40, counters: { poison: 0, energy: 0, experience: 0 },
  cmdDmg: {}, cmdDmg2: {}, ...over,
})

describe('isPlayerDead', () => {
  it('alive at positive life with no lethal counters', () => {
    expect(isPlayerDead(player())).toBe(false)
  })
  it('dead at 0 or less life', () => {
    expect(isPlayerDead(player({ life: 0 }))).toBe(true)
    expect(isPlayerDead(player({ life: -3 }))).toBe(true)
  })
  it('dead at 10+ poison, alive below', () => {
    expect(isPlayerDead(player({ counters: { poison: 9 } }))).toBe(false)
    expect(isPlayerDead(player({ counters: { poison: 10 } }))).toBe(true)
  })
  it('dead at 21+ commander damage from a single source (incl partner)', () => {
    expect(isPlayerDead(player({ cmdDmg: { 2: 21 } }))).toBe(true)
    expect(isPlayerDead(player({ cmdDmg2: { 3: 22 } }))).toBe(true)
    expect(isPlayerDead(player({ cmdDmg: { 2: 20, 3: 20 } }))).toBe(false)
  })
  it('tolerates missing counter/damage objects', () => {
    expect(isPlayerDead({ life: 40 })).toBe(false)
    expect(isPlayerDead(null)).toBe(false)
  })
})
