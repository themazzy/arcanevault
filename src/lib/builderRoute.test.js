import { describe, expect, it } from 'vitest'
import { clearNewDeckIntent, getBuilderIndexIntent } from './builderRoute'

describe('Builder index route intent', () => {
  it('opens the new-deck modal from the Home shortcut', () => {
    expect(getBuilderIndexIntent('?new=1')).toEqual({ pageTab: 'my', openNewDeck: true })
  })

  it('preserves unrelated query parameters when the modal closes', () => {
    expect(clearNewDeckIntent('?new=1&tab=browser')).toBe('?tab=browser')
  })
})
