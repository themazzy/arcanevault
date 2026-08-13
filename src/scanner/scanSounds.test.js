import { describe, it, expect } from 'vitest'
import { shouldPlayScanSound } from './scanSounds'

const card = (over = {}) => ({ uid: 'u1', id: 'sf-1', name: 'Sol Ring', ...over })
const printing = (over = {}) => ({ id: 'sf-1', prices: { eur: '1.00' }, ...over })

describe('shouldPlayScanSound', () => {
  it('sounds a newly scanned card once its own printing data has arrived', () => {
    expect(shouldPlayScanSound({
      card: card(), printingData: printing(), lastSoundedUid: null,
    })).toBe(true)
  })

  it('does not sound a card against the PREVIOUS card’s printing data', () => {
    // The reported bug: the fetch for card B is still in flight, so
    // latestPrintingData is still card A's row. Sounding here priced B off A —
    // an expensive card scanned silently and its chime landed on the next card.
    expect(shouldPlayScanSound({
      card: card({ uid: 'u2', id: 'sf-2' }),
      printingData: printing({ id: 'sf-1' }),
      lastSoundedUid: 'u1',
    })).toBe(false)
  })

  it('sounds once the right data catches up', () => {
    expect(shouldPlayScanSound({
      card: card({ uid: 'u2', id: 'sf-2' }),
      printingData: printing({ id: 'sf-2' }),
      lastSoundedUid: 'u1',
    })).toBe(true)
  })

  it('does not repeat for a card already sounded', () => {
    expect(shouldPlayScanSound({
      card: card(), printingData: printing(), lastSoundedUid: 'u1',
    })).toBe(false)
  })

  it('sounds again for a second copy of the same printing', () => {
    // Same card id, new basket entry — scanning two Sol Rings should click twice.
    expect(shouldPlayScanSound({
      card: card({ uid: 'u2' }), printingData: printing(), lastSoundedUid: 'u1',
    })).toBe(true)
  })

  it('stays silent while the printing data is still loading', () => {
    expect(shouldPlayScanSound({
      card: card(), printingData: null, lastSoundedUid: null,
    })).toBe(false)
  })

  it('stays silent with no card', () => {
    expect(shouldPlayScanSound({
      card: null, printingData: printing(), lastSoundedUid: null,
    })).toBe(false)
  })

  it('stays silent for a card with no printing id to match on', () => {
    expect(shouldPlayScanSound({
      card: card({ id: null }), printingData: printing(), lastSoundedUid: null,
    })).toBe(false)
  })
})
