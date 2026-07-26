import { describe, it, expect } from 'vitest'
import { matchesPrintingFilter, filterPrintings } from './printingFilter'

const mh3 = { id: 'a', set: 'mh3', set_name: 'Modern Horizons 3', collector_number: '225', released_at: '2024-06-14' }
const ltr = { id: 'b', set: 'ltr', set_name: 'The Lord of the Rings: Tales of Middle-earth', collector_number: '25', released_at: '2023-06-23' }
const c13 = { id: 'c', set: 'c13', set_name: 'Commander 2013', collector_number: '245', released_at: '2013-11-01' }

describe('matchesPrintingFilter', () => {
  it('matches everything on a blank query', () => {
    expect(matchesPrintingFilter(mh3, '')).toBe(true)
    expect(matchesPrintingFilter(mh3, '   ')).toBe(true)
    expect(matchesPrintingFilter(mh3, null)).toBe(true)
  })

  it('matches set code and set name case-insensitively', () => {
    expect(matchesPrintingFilter(mh3, 'MH3')).toBe(true)
    expect(matchesPrintingFilter(mh3, 'modern horizons')).toBe(true)
    expect(matchesPrintingFilter(mh3, 'commander')).toBe(false)
  })

  it('matches the release year', () => {
    expect(matchesPrintingFilter(mh3, '2024')).toBe(true)
    expect(matchesPrintingFilter(mh3, '2013')).toBe(false)
  })

  it('matches the collector number, with or without a leading #', () => {
    expect(matchesPrintingFilter(mh3, '225')).toBe(true)
    expect(matchesPrintingFilter(mh3, '#225')).toBe(true)
    expect(matchesPrintingFilter(mh3, '#226')).toBe(false)
  })

  it('matches collector numbers by prefix, not substring', () => {
    expect(matchesPrintingFilter(mh3, '22')).toBe(true)     // 225
    expect(matchesPrintingFilter(mh3, '#25')).toBe(false)   // not a prefix of 225
  })

  it('restricts a #-prefixed query to the collector number', () => {
    // "13" appears in Commander 2013's name and year, but not its number.
    expect(matchesPrintingFilter(c13, '13')).toBe(true)
    expect(matchesPrintingFilter(c13, '#13')).toBe(false)
  })

  it('falls back to the set_code field when set is absent', () => {
    expect(matchesPrintingFilter({ set_code: 'neo', collector_number: '1' }, 'neo')).toBe(true)
  })

  it('rejects a missing printing rather than throwing', () => {
    expect(matchesPrintingFilter(null, 'mh3')).toBe(false)
    expect(matchesPrintingFilter({}, 'mh3')).toBe(false)
  })
})

describe('filterPrintings', () => {
  const all = [mh3, ltr, c13]

  it('returns the original list for a blank query', () => {
    expect(filterPrintings(all, '')).toBe(all)
  })

  it('narrows to matching printings', () => {
    expect(filterPrintings(all, 'commander')).toEqual([c13])
    expect(filterPrintings(all, '2023')).toEqual([ltr])
    expect(filterPrintings(all, '#25')).toEqual([ltr])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterPrintings(all, 'zzz')).toEqual([])
  })

  it('tolerates a non-array input', () => {
    expect(filterPrintings(undefined, 'mh3')).toEqual([])
  })
})
