import { describe, expect, it } from 'vitest'
import { sortByNameRelevance } from './scryfallSearch'

describe('sortByNameRelevance', () => {
  it('ranks exact, prefix, then partial matches without disturbing ties', () => {
    const cards = [
      { name: 'Foggy Swamp' },
      { name: 'Swamp Thing' },
      { name: 'Leechridden Swamp' },
      { name: 'Swamp' },
      { name: 'Swamplord' },
    ]

    expect(sortByNameRelevance(cards, ' swamp ').map(card => card.name)).toEqual([
      'Swamp',
      'Swamp Thing',
      'Swamplord',
      'Foggy Swamp',
      'Leechridden Swamp',
    ])
  })

  it('moves an exact match into the visible window before truncation', () => {
    const partials = Array.from({ length: 8 }, (_, index) => ({ name: `Foggy Swamp ${index}` }))
    const ranked = sortByNameRelevance([...partials, { name: 'Swamp' }], 'Swamp').slice(0, 8)

    expect(ranked[0].name).toBe('Swamp')
    expect(ranked).toHaveLength(8)
  })
})
