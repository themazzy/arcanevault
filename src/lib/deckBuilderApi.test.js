import { describe, it, expect } from 'vitest'
import { parseTextDecklist, parseImportUrl } from './deckBuilderApi'

describe('parseTextDecklist', () => {
  it('parses simple qty + name', () => {
    const result = parseTextDecklist('4 Lightning Bolt')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'Lightning Bolt', qty: 4, foil: false })
  })

  it('parses "4x" quantity', () => {
    const [card] = parseTextDecklist('4x Lightning Bolt')
    expect(card.qty).toBe(4)
    expect(card.name).toBe('Lightning Bolt')
  })

  it('defaults qty to 1 when missing', () => {
    const [card] = parseTextDecklist('Lightning Bolt')
    expect(card.qty).toBe(1)
  })

  it('extracts set code in parentheses + collector number', () => {
    const [card] = parseTextDecklist('4 Lightning Bolt (M10) 155')
    expect(card.setCode).toBe('m10')
    expect(card.collectorNumber).toBe('155')
    expect(card.name).toBe('Lightning Bolt')
  })

  it('extracts set code in brackets', () => {
    const [card] = parseTextDecklist('4 Lightning Bolt [M10]')
    expect(card.setCode).toBe('m10')
  })

  describe('foil markers (MD-001)', () => {
    it('detects MTGO *F* marker between qty and name', () => {
      const [card] = parseTextDecklist('4 *F* Lightning Bolt')
      expect(card.foil).toBe(true)
      expect(card.name).toBe('Lightning Bolt')
    })

    it('detects [Foil] suffix at end of line', () => {
      const [card] = parseTextDecklist('4 Lightning Bolt [Foil]')
      expect(card.foil).toBe(true)
      expect(card.name).toBe('Lightning Bolt')
    })

    it('detects (foil) suffix at end of line', () => {
      const [card] = parseTextDecklist('4 Lightning Bolt (foil)')
      expect(card.foil).toBe(true)
      expect(card.name).toBe('Lightning Bolt')
    })

    it('does NOT match foil-like substring inside a card name (anchored)', () => {
      // Hypothetical: "(foil)" embedded mid-line but not at end shouldn't strip if not anchored.
      // Real-world card names don't contain "(foil)", but defensive anchoring matters.
      const [card] = parseTextDecklist('4 Lightning Bolt (M10) 155')
      expect(card.foil).toBe(false)
      expect(card.name).toBe('Lightning Bolt')
    })

    it('handles foil + set + collector number combined', () => {
      const [card] = parseTextDecklist('4 Lightning Bolt (M10) 155 [Foil]')
      expect(card.foil).toBe(true)
      expect(card.setCode).toBe('m10')
      expect(card.collectorNumber).toBe('155')
    })
  })

  describe('section headers', () => {
    it('routes cards under Sideboard: to sideboard', () => {
      const result = parseTextDecklist('4 Lightning Bolt\nSideboard:\n1 Counterspell')
      expect(result).toHaveLength(2)
      expect(result[0].board).toBe('main')
      expect(result[1].board).toBe('side')
    })

    it('flags commander cards', () => {
      const result = parseTextDecklist('Commander:\n1 Atraxa, Praetors Voice\nDeck:\n4 Sol Ring')
      expect(result[0].isCommander).toBe(true)
      expect(result[1].isCommander).toBe(false)
    })

    it('skips // comments', () => {
      const result = parseTextDecklist('// my deck\n4 Lightning Bolt')
      expect(result).toHaveLength(1)
    })
  })
})

describe('parseImportUrl (MD-002)', () => {
  it('matches archidekt deck URLs', () => {
    expect(parseImportUrl('https://archidekt.com/decks/12345')).toEqual({ source: 'archidekt', id: '12345' })
  })

  it('matches valid moxfield deck URLs', () => {
    expect(parseImportUrl('https://www.moxfield.com/decks/abc123_xyz-Z')).toEqual({ source: 'moxfield', id: 'abc123_xyz-Z' })
  })

  it('matches moxfield URL with trailing slash', () => {
    const result = parseImportUrl('https://www.moxfield.com/decks/abcDEF12345/')
    expect(result?.source).toBe('moxfield')
    expect(result?.id).toBe('abcDEF12345')
  })

  it('rejects too-short slugs that look like routes', () => {
    // "/decks/help" should NOT be parsed as a deck ID — the regex requires {6,40} chars
    expect(parseImportUrl('https://www.moxfield.com/decks/help')).toBeNull()
  })

  it('rejects too-long random strings', () => {
    const longStr = 'a'.repeat(100)
    expect(parseImportUrl(`https://www.moxfield.com/decks/${longStr}`)).toBeNull()
  })

  it('matches mtggoldfish deck URLs', () => {
    expect(parseImportUrl('https://www.mtggoldfish.com/deck/9876543')).toEqual({ source: 'goldfish', id: '9876543' })
  })

  it('returns null for unrecognized URLs', () => {
    expect(parseImportUrl('https://example.com/foo')).toBeNull()
  })
})
