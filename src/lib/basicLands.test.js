import { describe, it, expect } from 'vitest'
import { isBasicLandName, BASIC_LAND_TYPES } from './basicLands'

describe('isBasicLandName', () => {
  it('recognizes every basic land type, case-insensitively', () => {
    for (const { name } of BASIC_LAND_TYPES) {
      expect(isBasicLandName(name)).toBe(true)
      expect(isBasicLandName(name.toUpperCase())).toBe(true)
    }
  })

  it('recognizes Snow-Covered variants', () => {
    expect(isBasicLandName('Snow-Covered Forest')).toBe(true)
    expect(isBasicLandName('Snow-Covered Island')).toBe(true)
  })

  it('rejects non-basic lands and nonsense input', () => {
    expect(isBasicLandName('Command Tower')).toBe(false)
    expect(isBasicLandName('Reliquary Tower')).toBe(false)
    expect(isBasicLandName('')).toBe(false)
    expect(isBasicLandName(null)).toBe(false)
    expect(isBasicLandName(undefined)).toBe(false)
  })

  // The deck-builder duplicate-card warning used to key off a card's
  // `type_line` string to exempt basics from singleton checks. Different
  // printings of the same basic don't always carry that field consistently,
  // which caused false "N copies" warnings for cards like Forest when the
  // collection held several printings. Detection must key off the name only.
  it('identifies basics by name regardless of type_line data', () => {
    expect(isBasicLandName('Forest')).toBe(true)
  })
})
