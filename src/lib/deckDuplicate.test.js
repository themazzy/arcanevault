import { describe, it, expect } from 'vitest'
import { makeDeckCopyMeta } from './deckDuplicate'

describe('makeDeckCopyMeta', () => {
  const source = {
    format: 'commander',
    commanderName: 'Atraxa, Praetors\' Voice',
    tags: ['superfriends'],
    bracket: 3,
    is_public: true,
    linked_deck_id: 'collection-side',
    linked_builder_id: 'builder-side',
    sync_state: { unsynced_builder: true },
    last_sync_at: '2026-08-01T00:00:00Z',
    last_sync_snapshot: [{ name: 'Sol Ring' }],
    unsynced_builder: true,
    unsynced_collection: true,
    hideFromBuilder: true,
  }

  it('keeps the deck content fields', () => {
    const copy = makeDeckCopyMeta(source)
    expect(copy.format).toBe('commander')
    expect(copy.commanderName).toBe('Atraxa, Praetors\' Voice')
    expect(copy.tags).toEqual(['superfriends'])
    expect(copy.bracket).toBe(3)
  })

  it('drops every link to the original deck', () => {
    const copy = makeDeckCopyMeta(source)
    for (const key of [
      'linked_deck_id', 'linked_builder_id', 'sync_state', 'last_sync_at',
      'last_sync_snapshot', 'unsynced_builder', 'unsynced_collection', 'hideFromBuilder',
    ]) {
      expect(copy, `${key} should not survive the copy`).not.toHaveProperty(key)
    }
  })

  it('always starts the copy private', () => {
    expect(makeDeckCopyMeta(source).is_public).toBe(false)
    expect(makeDeckCopyMeta({ is_public: false }).is_public).toBe(false)
  })

  it('does not mutate the source meta', () => {
    const input = { ...source }
    makeDeckCopyMeta(input)
    expect(input.linked_deck_id).toBe('collection-side')
    expect(input.is_public).toBe(true)
  })

  it('tolerates a missing meta', () => {
    expect(makeDeckCopyMeta(null)).toEqual({ is_public: false })
  })
})
