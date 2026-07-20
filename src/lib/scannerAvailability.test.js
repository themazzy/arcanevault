import { describe, expect, it } from 'vitest'
import { shouldOfferCardScanner } from './scannerAvailability'

describe('shouldOfferCardScanner', () => {
  it('offers Scanner in the native app regardless of pointer type', () => {
    expect(shouldOfferCardScanner({ native: true, matchMedia: () => ({ matches: false }) })).toBe(true)
  })

  it('offers Scanner to coarse-pointer mobile and tablet browsers', () => {
    expect(shouldOfferCardScanner({ native: false, matchMedia: () => ({ matches: true }) })).toBe(true)
  })

  it('hides Scanner from fine-pointer desktop browsers', () => {
    expect(shouldOfferCardScanner({ native: false, matchMedia: () => ({ matches: false }) })).toBe(false)
  })

  it('defaults to hidden when pointer capabilities are unavailable', () => {
    expect(shouldOfferCardScanner({ native: false, matchMedia: null })).toBe(false)
  })
})
