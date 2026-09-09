import { describe, it, expect } from 'vitest'
import { ESTABLISHED_BEFORE, isEstablishedKeyword, needsNoveltyLookup } from './establishedKeywords'

const STAR_TREK = '2026-11-13'

describe('established keywords', () => {
  it('knows the evergreen keywords', () => {
    for (const kw of ['Flying', 'First strike', 'Trample', 'Deathtouch', 'Vigilance', 'Menace']) {
      expect(isEstablishedKeyword(kw)).toBe(true)
    }
  })

  it('knows the older non-evergreen ones too', () => {
    for (const kw of ['Cycling', 'Landcycling', 'Kicker', 'Ward', 'Surveil', 'Landfall', 'Investigate']) {
      expect(isEstablishedKeyword(kw)).toBe(true)
    }
  })

  // These postdate the cutoff, so they are exactly the ones worth asking about.
  it('does not claim a recent mechanic is established', () => {
    for (const kw of ['Station', 'Mayhem', 'Max speed', 'Impending', 'Offspring']) {
      expect(isEstablishedKeyword(kw)).toBe(false)
    }
  })
})

describe('needsNoveltyLookup', () => {
  it('skips a keyword that already existed when the set was printed', () => {
    expect(needsNoveltyLookup('Flying', STAR_TREK)).toBe(false)
  })

  it('still asks about a keyword that could be new', () => {
    expect(needsNoveltyLookup('Station', STAR_TREK)).toBe(true)
    expect(needsNoveltyLookup('Face a dilemma', STAR_TREK)).toBe(true)
  })

  // The list says "printed before the cutoff", which tells us nothing about a
  // set printed before it too — that set's own printing may be the first.
  it('asks about everything for a set older than the cutoff', () => {
    expect(needsNoveltyLookup('Flying', '2001-10-01')).toBe(true)
    expect(needsNoveltyLookup('Flying', ESTABLISHED_BEFORE)).toBe(true)
  })

  it('asks when the release date is unknown rather than assuming', () => {
    expect(needsNoveltyLookup('Flying', null)).toBe(true)
    expect(needsNoveltyLookup('Flying', undefined)).toBe(true)
  })

  it('asks about a keyword it has never heard of', () => {
    expect(needsNoveltyLookup('Photosynthesise', STAR_TREK)).toBe(true)
  })

  // The whole point: Star Trek's 25 keywords should cost 2 requests, not 25.
  it('cuts a real set down to the keywords that could actually be new', () => {
    const starTrekKeywords = [
      'Flying', 'Landcycling', 'Basic landcycling', 'Typecycling', 'Cycling', 'Surveil',
      'Landfall', 'Flash', 'Vigilance', 'Trample', 'Lifelink', 'Reach', 'Enchant', 'Kicker',
      'Ward', 'Deathtouch', 'Equip', 'Menace', 'Mill', 'Fight', 'First strike', 'Explore',
      'Investigate', 'Face a dilemma', 'Station',
    ]
    const asked = starTrekKeywords.filter(kw => needsNoveltyLookup(kw, STAR_TREK))
    expect(asked).toEqual(['Face a dilemma', 'Station'])
  })
})
