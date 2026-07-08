import { describe, it, expect } from 'vitest'
import { parseManaboxCSV, CSVParseError } from './csvParser'

describe('parseManaboxCSV — header validation', () => {
  it('throws CSVParseError when the name column is missing', () => {
    const bad = 'set,quantity\nm10,3'
    expect(() => parseManaboxCSV(bad)).toThrow(CSVParseError)
    expect(() => parseManaboxCSV(bad)).toThrow(/name/i)
  })

  it('returns empty for empty/single-line input without throwing', () => {
    expect(parseManaboxCSV('')).toEqual({ cards: [], folders: {} })
    expect(parseManaboxCSV('name,set')).toEqual({ cards: [], folders: {} })
  })

  it('parses a minimal valid CSV', () => {
    const csv = 'name,set code,collector number,quantity,foil\nLightning Bolt,m10,146,4,foil'
    const { cards } = parseManaboxCSV(csv)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      name: 'Lightning Bolt',
      set_code: 'm10',
      collector_number: '146',
      qty: 4,
      foil: true,
    })
  })

  it('groups cards into folders by binder name', () => {
    const csv = [
      'name,set code,quantity,binder name,binder type',
      'Lightning Bolt,m10,2,Red Deck,deck',
      'Counterspell,7ed,1,Red Deck,deck',
      'Wishlist Card,sld,1,Want List,list',
    ].join('\n')
    const { cards, folders } = parseManaboxCSV(csv)
    expect(cards).toHaveLength(3)
    expect(Object.keys(folders).sort()).toEqual(['deck|Red Deck', 'list|Want List'])
    expect(folders['deck|Red Deck'].type).toBe('deck')
    expect(folders['deck|Red Deck'].cards).toHaveLength(2)
    expect(folders['list|Want List'].type).toBe('list')
  })

  it('keeps same-named locations separate when their types differ', () => {
    const csv = [
      'name,set code,quantity,binder name,binder type',
      'Arachnogenesis,dsc,1,Tadeas,list',
      'Arcades the Strategist,m19,1,Tadeas,deck',
    ].join('\n')

    const { cards, folders } = parseManaboxCSV(csv)

    expect(Object.keys(folders).sort()).toEqual(['deck|Tadeas', 'list|Tadeas'])
    expect(folders['deck|Tadeas'].cards.map(card => card.name)).toEqual(['Arcades the Strategist'])
    expect(folders['list|Tadeas'].cards.map(card => card.name)).toEqual(['Arachnogenesis'])
    expect(cards.map(card => card._binderKey)).toEqual(['list|Tadeas', 'deck|Tadeas'])
  })

  it('handles quoted fields with embedded commas', () => {
    const csv = 'name,set code,quantity\n"Fire // Ice",apc,1\n"A name, with comma",m10,2'
    const { cards } = parseManaboxCSV(csv)
    expect(cards.map(c => c.name)).toEqual(['Fire // Ice', 'A name, with comma'])
    expect(cards[1].qty).toBe(2)
  })

  it('handles "" as an escaped quote inside a quoted field', () => {
    const csv = 'name,set code,quantity\n"Say ""Hi""",m10,1'
    const { cards } = parseManaboxCSV(csv)
    expect(cards[0].name).toBe('Say "Hi"')
  })
})

describe('parseManaboxCSV — parseCSVRow trailing-field flush', () => {
  it('does not drop the last field when a quote is left unclosed (regression)', () => {
    // Without the explicit flush, "abc" got dropped when the loop ended inside an open quote.
    // We trigger via header parsing: an unclosed-quote row should still expose all columns.
    const csv = 'name,note\nLightning Bolt,"unclosed note'
    const { cards } = parseManaboxCSV(csv)
    expect(cards).toHaveLength(1)
    expect(cards[0].name).toBe('Lightning Bolt')
  })

  it('does not drop the last field when a row simply ends with a value (no trailing comma)', () => {
    const csv = 'name,set code,quantity\nLightning Bolt,m10,4'
    const { cards } = parseManaboxCSV(csv)
    expect(cards[0].qty).toBe(4)
  })

  it('preserves a trailing empty field after a comma', () => {
    const csv = 'name,set code,quantity,foil\nLightning Bolt,m10,1,'
    const { cards } = parseManaboxCSV(csv)
    expect(cards[0].foil).toBe(false)
  })
})
