import { describe, it, expect } from 'vitest'
import { colorIdentityMatches } from './colorFilter'

const match = (ci, colors, mode = 'any') => colorIdentityMatches(ci, colors, mode)

describe('colorIdentityMatches — WUBRG base filter', () => {
  it('returns true when no colors are selected (no filter applied)', () => {
    expect(match(['W'], [])).toBe(true)
    expect(match([], [])).toBe(true)
    expect(match(['W', 'U', 'B'], null)).toBe(true)
    expect(match(null, undefined)).toBe(true)
  })

  it('exact mode matches only when ci equals selection', () => {
    expect(match(['W', 'U'], ['W', 'U'], 'exact')).toBe(true)
    expect(match(['U', 'W'], ['W', 'U'], 'exact')).toBe(true)
    expect(match(['W'],      ['W', 'U'], 'exact')).toBe(false)
    expect(match(['W', 'U', 'G'], ['W', 'U'], 'exact')).toBe(false)
  })

  it('including mode requires every selected color present (extras allowed)', () => {
    expect(match(['W', 'U'],      ['W'],      'including')).toBe(true)
    expect(match(['W', 'U', 'G'], ['W', 'U'], 'including')).toBe(true)
    expect(match(['U'],           ['W', 'U'], 'including')).toBe(false)
  })

  it('any mode matches when at least one selected color is present', () => {
    expect(match(['G'],      ['W', 'G'], 'any')).toBe(true)
    expect(match(['U', 'B'], ['W'],      'any')).toBe(false)
  })
})

describe('colorIdentityMatches — M (multi-color) acts as Scryfall id>1 AND', () => {
  it('M alone matches multi-color cards and rejects mono/colorless', () => {
    expect(match(['W', 'U'], ['M'])).toBe(true)
    expect(match(['W', 'U', 'B'], ['M'])).toBe(true)
    expect(match(['W'], ['M'])).toBe(false)
    expect(match([],    ['M'])).toBe(false)
  })

  it('M layered with WUBRG narrows, never widens (the bug this helper fixes)', () => {
    // Old OR behaviour: 'W exact + M' returned any multi-color card.
    // Scryfall AND behaviour: result must be exactly W AND multi → impossible.
    expect(match(['W'],      ['W', 'M'], 'exact')).toBe(false)
    expect(match(['W', 'U'], ['W', 'M'], 'exact')).toBe(false)
    // 'W including + M' = cards containing W AND multi-color
    expect(match(['W'],      ['W', 'M'], 'including')).toBe(false) // mono-W rejected
    expect(match(['W', 'U'], ['W', 'M'], 'including')).toBe(true)
    expect(match(['U', 'G'], ['W', 'M'], 'including')).toBe(false) // no W
  })
})

describe('colorIdentityMatches — C (colorless) acts as Scryfall id:c AND', () => {
  it('C alone matches colorless and rejects anything with a color', () => {
    expect(match([],         ['C'])).toBe(true)
    expect(match(['W'],      ['C'])).toBe(false)
    expect(match(['W', 'U'], ['C'])).toBe(false)
  })

  it('C combined with WUBRG is impossible — no colorless card has W in identity', () => {
    expect(match([],    ['W', 'C'], 'exact'))     .toBe(false)
    expect(match(['W'], ['W', 'C'], 'including')) .toBe(false)
    expect(match([],    ['W', 'C'], 'including')) .toBe(false)
  })

  it('M + C together is impossible (can\'t be both multi-color and colorless)', () => {
    expect(match([],         ['M', 'C'])).toBe(false)
    expect(match(['W', 'U'], ['M', 'C'])).toBe(false)
    expect(match(['W'],      ['M', 'C'])).toBe(false)
  })
})

describe('colorIdentityMatches — falsy ci defaults to colorless', () => {
  it('treats null/undefined identity as []', () => {
    expect(match(undefined, ['C'])).toBe(true)
    expect(match(null,      ['C'])).toBe(true)
    expect(match(undefined, ['M'])).toBe(false)
  })
})
