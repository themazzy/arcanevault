import { describe, expect, it } from 'vitest'
import {
  filterDestinationFolders,
  hasDestinationNamed,
  isSaveDestinationFolder,
  isSaveDestinationType,
} from './saveDestinations'

const group = { isGroup: true }

// A linked pair: the collection deck and its builder twin share a name, which
// is what made the picker show "Krenko" twice.
const FOLDERS = [
  { id: 'b1', name: 'Rares', type: 'binder' },
  { id: 'd1', name: 'Krenko', type: 'deck' },
  { id: 'bd1', name: 'Krenko', type: 'builder_deck' },
  { id: 'bd2', name: 'Brewing', type: 'builder_deck' },
  { id: 'l1', name: 'Wants', type: 'list' },
  { id: 'g1', name: 'Commander decks', type: 'deck', description: JSON.stringify(group) },
  { id: 'g2', name: 'Binder shelf', type: 'binder', description: JSON.stringify(group) },
]

describe('isSaveDestinationType', () => {
  it('accepts the three folder types that hold owned cards', () => {
    expect(isSaveDestinationType('binder')).toBe(true)
    expect(isSaveDestinationType('deck')).toBe(true)
    expect(isSaveDestinationType('list')).toBe(true)
  })

  it('rejects builder decks and unknown types', () => {
    expect(isSaveDestinationType('builder_deck')).toBe(false)
    expect(isSaveDestinationType('')).toBe(false)
    expect(isSaveDestinationType(undefined)).toBe(false)
  })
})

describe('isSaveDestinationFolder', () => {
  it('rejects group folders even when the type is right', () => {
    expect(isSaveDestinationFolder({ type: 'deck' })).toBe(true)
    expect(isSaveDestinationFolder({ type: 'deck', description: JSON.stringify(group) })).toBe(false)
  })

  it('tolerates a non-JSON description', () => {
    expect(isSaveDestinationFolder({ type: 'binder', description: 'my shiny binder' })).toBe(true)
  })

  it('rejects nullish input', () => {
    expect(isSaveDestinationFolder(null)).toBe(false)
  })
})

describe('filterDestinationFolders', () => {
  it('lists collection decks only — never the builder twin of a linked pair', () => {
    const decks = filterDestinationFolders(FOLDERS, { type: 'deck' })
    expect(decks.map(f => f.id)).toEqual(['d1'])
  })

  it('drops group folders from the binder tab', () => {
    const binders = filterDestinationFolders(FOLDERS, { type: 'binder' })
    expect(binders.map(f => f.id)).toEqual(['b1'])
  })

  it('narrows by search, case-insensitively', () => {
    expect(filterDestinationFolders(FOLDERS, { type: 'deck', search: 'kren' }).map(f => f.id)).toEqual(['d1'])
    expect(filterDestinationFolders(FOLDERS, { type: 'deck', search: 'brew' })).toEqual([])
    expect(filterDestinationFolders(FOLDERS, { type: 'list', search: '  ' }).map(f => f.id)).toEqual(['l1'])
  })

  it('handles missing input', () => {
    expect(filterDestinationFolders(null, { type: 'deck' })).toEqual([])
  })
})

describe('hasDestinationNamed', () => {
  it('matches an existing collection deck by name, ignoring case and padding', () => {
    expect(hasDestinationNamed(FOLDERS, { type: 'deck', name: '  krenko ' })).toBe(true)
  })

  it('does not treat a builder-only name as taken', () => {
    expect(hasDestinationNamed(FOLDERS, { type: 'deck', name: 'Brewing' })).toBe(false)
  })

  it('does not treat a group folder name as taken', () => {
    expect(hasDestinationNamed(FOLDERS, { type: 'deck', name: 'Commander decks' })).toBe(false)
  })

  it('is false for an empty name', () => {
    expect(hasDestinationNamed(FOLDERS, { type: 'deck', name: '   ' })).toBe(false)
  })
})
