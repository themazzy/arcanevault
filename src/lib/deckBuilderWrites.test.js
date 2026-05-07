import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase + cardPrints before importing the module under test, so the
// imports resolve to our test doubles.
vi.mock('./supabase', () => ({
  sb: {
    from: vi.fn(),
  },
}))
vi.mock('./cardPrints', () => ({
  ensureCardPrints: vi.fn(async () => new Map()),
  getCardPrint: vi.fn(),
  withCardPrint: vi.fn((row, print) => ({ ...row, card_print_id: print?.id || row.card_print_id })),
}))

const { sb } = await import('./supabase')
const { additiveSaveOwnedCards, ownedCardKey, toDeckCardRow, toCardPrintSource } = await import('./deckBuilderWrites')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toDeckCardRow', () => {
  it('only includes whitelisted DB columns', () => {
    const row = {
      id: 'a', deck_id: 'd', user_id: 'u', name: 'Sol Ring',
      __ignoredField: 'x', _folder_qty: 99,
    }
    const result = toDeckCardRow(row)
    expect(result).toHaveProperty('id', 'a')
    expect(result).toHaveProperty('name', 'Sol Ring')
    expect(result).not.toHaveProperty('__ignoredField')
    expect(result).not.toHaveProperty('_folder_qty')
  })

  it('does not include columns that are absent from the row', () => {
    const result = toDeckCardRow({ id: 'a', name: 'X' })
    expect(result).not.toHaveProperty('cmc')
    expect(result).not.toHaveProperty('foil')
  })
})

describe('toCardPrintSource', () => {
  it('normalizes set vs set_code variants', () => {
    expect(toCardPrintSource({ set: 'M10' }).set_code).toBe('M10')
    expect(toCardPrintSource({ set_code: 'M10' }).set_code).toBe('M10')
  })

  it('preserves cmc=0 (uses ?? not ||)', () => {
    expect(toCardPrintSource({ cmc: 0 }).cmc).toBe(0)
  })

  it('defaults missing color_identity to []', () => {
    expect(toCardPrintSource({}).color_identity).toEqual([])
  })
})

describe('ownedCardKey', () => {
  it('keys by card_print_id, foil, language, condition', () => {
    expect(ownedCardKey({ card_print_id: 'cp-1', foil: false }))
      .toBe('cp-1|0|en|near_mint')
    expect(ownedCardKey({ card_print_id: 'cp-1', foil: true, language: 'jp', condition: 'lp' }))
      .toBe('cp-1|1|jp|lp')
  })

  it('uses defaults when language/condition missing', () => {
    const key = ownedCardKey({ card_print_id: 'cp-1', foil: false })
    expect(key.endsWith('en|near_mint')).toBe(true)
  })
})

describe('additiveSaveOwnedCards (HI-005)', () => {
  it('throws when rows have multiple user_ids', async () => {
    const rows = [
      { card_print_id: 'cp-1', user_id: 'user-A', qty: 1 },
      { card_print_id: 'cp-1', user_id: 'user-B', qty: 1 },
    ]
    await expect(additiveSaveOwnedCards(rows)).rejects.toThrow(/multiple user_ids/)
  })

  it('throws when rows are missing user_id', async () => {
    const rows = [{ card_print_id: 'cp-1', qty: 1 }]
    await expect(additiveSaveOwnedCards(rows)).rejects.toThrow(/missing user_id/)
  })

  it('returns [] when input is empty', async () => {
    const result = await additiveSaveOwnedCards([])
    expect(result).toEqual([])
  })

  it('aggregates qty across rows with the same key before writing', async () => {
    // Build a chainable supabase mock: from().select().eq().in() returns existing rows;
    // from().upsert().select() returns saved rows.
    const upsertCalls = []
    sb.from.mockImplementation((table) => {
      const builder = {
        _table: table,
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
        upsert: vi.fn(function (rows) {
          upsertCalls.push({ table, rows })
          return {
            select: vi.fn().mockResolvedValue({ data: rows, error: null }),
          }
        }),
      }
      return builder
    })

    const rows = [
      { card_print_id: 'cp-1', user_id: 'user-A', qty: 2, foil: false },
      { card_print_id: 'cp-1', user_id: 'user-A', qty: 3, foil: false },
    ]
    await additiveSaveOwnedCards(rows)

    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].rows).toHaveLength(1)
    expect(upsertCalls[0].rows[0].qty).toBe(5)
  })

  it('sums qty into existing row when one is found', async () => {
    sb.from.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [{
          id: 'existing-1',
          user_id: 'user-A',
          card_print_id: 'cp-1',
          foil: false,
          qty: 4,
          purchase_price: 1.50,
          currency: 'EUR',
        }],
        error: null,
      }),
      upsert: vi.fn(function (rows) {
        return { select: vi.fn().mockResolvedValue({ data: rows, error: null }) }
      }),
    }))

    const result = await additiveSaveOwnedCards([
      { card_print_id: 'cp-1', user_id: 'user-A', qty: 2, foil: false },
    ])
    expect(result[0].qty).toBe(6) // 4 existing + 2 new
    expect(result[0].id).toBe('existing-1') // preserves existing id
    expect(result[0].purchase_price).toBe(1.50) // preserves existing price
  })
})
