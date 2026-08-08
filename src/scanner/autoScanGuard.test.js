/**
 * Auto-scan duplicate-guard tests.
 *
 * Written against a real device log (2026-08-08) in which one physical
 * "Vivi Ornitier" was added to the basket four times and one "Command Tower"
 * three times. Every repeat was separated by a ceiling rejection of the SAME
 * card (94-99 against MATCH_ACCEPT_CEILING 93), because a miss used to clear
 * the guard — so the next hit looked like a brand-new card.
 */

import { describe, it, expect } from 'vitest'
import {
  getAutoScanCardSignature,
  isAutoScanDuplicate,
  nextRememberedSignature,
  shouldReleaseGuard,
} from './autoScanGuard'

// Minimal replay of the scan loop's guard bookkeeping: feed it attempts, get
// back what would have been added to the basket.
function replay(attempts, { isAutoScan = true } = {}) {
  let remembered = null
  const added = []
  for (const a of attempts) {
    if (a.lostForMs !== undefined) {
      // A run of quad-less probes between scans.
      if (shouldReleaseGuard({ quadLostSince: 1, now: 1 + a.lostForMs, graceMs: 2000 })) remembered = null
      continue
    }
    const signature = a.name ? getAutoScanCardSignature({ name: a.name }, a.foil ?? false) : null
    const dup = isAutoScanDuplicate({ isAutoScan, signature, remembered })
    remembered = nextRememberedSignature({ isAutoScan, signature, remembered })
    if (a.name && !dup) added.push(a.name)
  }
  return added
}

describe('getAutoScanCardSignature', () => {
  it('ignores printing, case and surrounding space but not foil', () => {
    expect(getAutoScanCardSignature({ name: ' Command Tower ', id: 'a' }))
      .toBe(getAutoScanCardSignature({ name: 'command tower', id: 'b' }))
    expect(getAutoScanCardSignature({ name: 'Command Tower' }, true))
      .not.toBe(getAutoScanCardSignature({ name: 'Command Tower' }, false))
  })
})

describe('a miss does not re-arm the guard', () => {
  it('adds one card for the logged Vivi Ornitier hit/miss alternation', () => {
    // 18:35:16 hit · miss · hit · miss · miss · hit · miss ×4 · hit · hit(dup)
    const added = replay([
      { name: 'Vivi Ornitier' },
      { name: null }, { name: 'Vivi Ornitier' },
      { name: null }, { name: null }, { name: 'Vivi Ornitier' },
      { name: null }, { name: null }, { name: null }, { name: null },
      { name: 'Vivi Ornitier' }, { name: 'Vivi Ornitier' },
    ])
    expect(added).toEqual(['Vivi Ornitier'])
  })

  it('adds one card for the logged Command Tower sequence', () => {
    const added = replay([
      { name: null }, { name: null }, { name: null }, { name: null },
      { name: 'Command Tower' },
      { name: null }, { name: null },
      { name: 'Command Tower' },
      { name: null },
    ])
    expect(added).toEqual(['Command Tower'])
  })

  it('still adds a different card that appears between misses', () => {
    expect(replay([
      { name: 'Dragon\'s Hoard' }, { name: null }, { name: 'Mary Jane Watson' },
    ])).toEqual(['Dragon\'s Hoard', 'Mary Jane Watson'])
  })

  it('treats the same name in the other finish as a new card', () => {
    expect(replay([
      { name: 'Sol Ring', foil: false }, { name: 'Sol Ring', foil: true },
    ])).toEqual(['Sol Ring', 'Sol Ring'])
  })
})

describe('the card leaving frame re-arms the guard', () => {
  it('re-adds the same name after a long enough quad-less run', () => {
    expect(replay([
      { name: 'Sol Ring' }, { lostForMs: 2400 }, { name: 'Sol Ring' },
    ])).toEqual(['Sol Ring', 'Sol Ring'])
  })

  it('does not re-add on a short detection dropout with the card still there', () => {
    expect(replay([
      { name: 'Sol Ring' }, { lostForMs: 900 }, { name: 'Sol Ring' },
    ])).toEqual(['Sol Ring'])
  })
})

describe('shouldReleaseGuard', () => {
  it('never releases while a quad is showing', () => {
    expect(shouldReleaseGuard({ quadLostSince: 0, now: 1e9, graceMs: 2000 })).toBe(false)
  })

  it('releases exactly at the grace boundary', () => {
    expect(shouldReleaseGuard({ quadLostSince: 1000, now: 2999, graceMs: 2000 })).toBe(false)
    expect(shouldReleaseGuard({ quadLostSince: 1000, now: 3000, graceMs: 2000 })).toBe(true)
  })
})

describe('manual scans', () => {
  it('are never suppressed and never arm the guard', () => {
    expect(replay([
      { name: 'Sol Ring' }, { name: 'Sol Ring' }, { name: 'Sol Ring' },
    ], { isAutoScan: false })).toEqual(['Sol Ring', 'Sol Ring', 'Sol Ring'])
  })
})
