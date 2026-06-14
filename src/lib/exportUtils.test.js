import { describe, it, expect } from 'vitest'
import { cardsToArena, cardsToMtgoDek, cardsToBuylist } from './exportUtils'

const deck = [
  { name: 'Atraxa, Praetors Voice', set_code: 'cmr', collector_number: '28', qty: 1, is_commander: true },
  { name: 'Sol Ring',     set_code: 'c21', collector_number: '263', qty: 1, board: 'main' },
  { name: 'Lightning Bolt', set_code: 'm10', collector_number: '146', qty: 4, board: 'main' },
  { name: 'Negate',      set_code: 'm21', collector_number: '54', qty: 2, board: 'side' },
  { name: 'Maybe Card',  set_code: 'xxx', collector_number: '1', qty: 1, board: 'maybe' },
]

describe('cardsToArena', () => {
  it('groups into Commander / Deck / Sideboard with set + number', () => {
    const out = cardsToArena(deck)
    expect(out).toContain('Commander\n1 Atraxa, Praetors Voice (CMR) 28')
    expect(out).toContain('Deck\n1 Sol Ring (C21) 263\n4 Lightning Bolt (M10) 146')
    expect(out).toContain('Sideboard\n2 Negate (M21) 54')
  })

  it('excludes the maybe board', () => {
    expect(cardsToArena(deck)).not.toContain('Maybe Card')
  })

  it('falls back to qty + name when set is missing', () => {
    expect(cardsToArena([{ name: 'Forest', qty: 10, board: 'main' }])).toBe('Deck\n10 Forest')
  })
})

describe('cardsToMtgoDek', () => {
  it('emits .dek XML with Sideboard flags and excludes maybe', () => {
    const out = cardsToMtgoDek(deck)
    expect(out).toMatch(/^<\?xml/)
    expect(out).toContain('Quantity="4" Sideboard="false" Name="Lightning Bolt"')
    expect(out).toContain('Quantity="2" Sideboard="true" Name="Negate"')
    expect(out).toContain('Sideboard="false" Name="Atraxa, Praetors Voice"')
    expect(out).not.toContain('Maybe Card')
    expect(out.trim().endsWith('</Deck>')).toBe(true)
  })

  it('escapes XML-special characters in names', () => {
    const out = cardsToMtgoDek([{ name: 'Borrowing 100,000 Arrows & "Stuff"', qty: 1 }])
    expect(out).toContain('Name="Borrowing 100,000 Arrows &amp; &quot;Stuff&quot;"')
  })
})

describe('cardsToBuylist', () => {
  it('sums by name, sorts alphabetically, excludes maybe', () => {
    const out = cardsToBuylist([
      { name: 'Sol Ring', qty: 1 },
      { name: 'Lightning Bolt', qty: 2 },
      { name: 'Lightning Bolt', qty: 2 },
      { name: 'Maybe Card', qty: 1, board: 'maybe' },
    ])
    expect(out).toBe('4 Lightning Bolt\n1 Sol Ring')
  })

  it('returns empty string for an empty list', () => {
    expect(cardsToBuylist([])).toBe('')
  })
})
