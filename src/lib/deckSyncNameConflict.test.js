import { describe, it, expect } from 'vitest'
import { isUniqueNameConflict, resolveBuilderNameConflict } from './deckSync'

describe('isUniqueNameConflict', () => {
  it('recognises the Postgres unique violation code', () => {
    // folders carries UNIQUE (user_id, name, type).
    expect(isUniqueNameConflict({ code: '23505' })).toBe(true)
  })

  it('recognises the HTTP status PostgREST surfaces it as', () => {
    expect(isUniqueNameConflict({ status: 409 })).toBe(true)
    expect(isUniqueNameConflict({ statusCode: 409 })).toBe(true)
  })

  it('does not swallow other failures', () => {
    expect(isUniqueNameConflict({ code: '23503' })).toBe(false)   // FK violation
    expect(isUniqueNameConflict({ status: 500 })).toBe(false)
    expect(isUniqueNameConflict({ message: 'network down' })).toBe(false)
    expect(isUniqueNameConflict(null)).toBe(false)
    expect(isUniqueNameConflict(undefined)).toBe(false)
  })
})

describe('resolveBuilderNameConflict', () => {
  const builderDeck = (over = {}) => ({
    id: 'b1', name: 'Buff snake', description: null, ...over,
  })

  it('offers to adopt an unlinked builder deck of the same name', () => {
    expect(resolveBuilderNameConflict(builderDeck())).toEqual({
      action: 'adopt', builderDeckId: 'b1',
    })
  })

  it('adopts when the description exists but carries no link', () => {
    const existing = builderDeck({ description: JSON.stringify({ format: 'commander' }) })
    expect(resolveBuilderNameConflict(existing).action).toBe('adopt')
  })

  it('refuses when that builder deck is already paired with another collection deck', () => {
    const existing = builderDeck({ description: JSON.stringify({ linked_deck_id: 'd-other' }) })
    const result = resolveBuilderNameConflict(existing)
    expect(result.action).toBe('already-paired')
    expect(result.reason).toContain('Buff snake')
    expect(result.reason).toContain('already paired')
  })

  it('reports an unknown state rather than guessing when nothing was found', () => {
    expect(resolveBuilderNameConflict(null).action).toBe('unknown')
    expect(resolveBuilderNameConflict({}).action).toBe('unknown')
    expect(resolveBuilderNameConflict(null).reason).toBeTruthy()
  })

  it('survives an unparseable description by treating it as unlinked', () => {
    const existing = builderDeck({ description: '{not json' })
    expect(resolveBuilderNameConflict(existing).action).toBe('adopt')
  })
})
