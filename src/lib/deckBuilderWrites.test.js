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
const {
  additiveSaveOwnedCards, additiveSaveWishlistItems, ownedCardKey,
  toDeckCardRow, toCardPrintSource, buildOwnedCardUpsertRows, resolvePurchasePrice,
} = await import('./deckBuilderWrites')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toDeckCardRow', () => {
  it('only includes whitelisted DB columns and strips denormalized print fields', () => {
    const row = {
      id: 'a', deck_id: 'd', user_id: 'u', card_print_id: 'cp-1',
      qty: 1, foil: false, board: 'main',
      // Denormalized print fields — phase 5d sources these from card_prints
      // via deck_cards_view, so they must NOT reach the base table.
      name: 'Sol Ring', set_code: 'C21', collector_number: '300',
      scryfall_id: 'sf-1', type_line: 'Artifact', mana_cost: '{1}', cmc: 1,
      color_identity: [], image_uri: 'http://x',
      // Internal client-side noise that should be filtered out:
      __ignoredField: 'x', _folder_qty: 99,
    }
    const result = toDeckCardRow(row)
    expect(result).toHaveProperty('id', 'a')
    expect(result).toHaveProperty('card_print_id', 'cp-1')
    expect(result).toHaveProperty('qty', 1)
    expect(result).not.toHaveProperty('name')
    expect(result).not.toHaveProperty('set_code')
    expect(result).not.toHaveProperty('scryfall_id')
    expect(result).not.toHaveProperty('type_line')
    expect(result).not.toHaveProperty('image_uri')
    expect(result).not.toHaveProperty('__ignoredField')
    expect(result).not.toHaveProperty('_folder_qty')
  })

  it('does not include columns that are absent from the row', () => {
    const result = toDeckCardRow({ id: 'a', deck_id: 'd' })
    expect(result).not.toHaveProperty('foil')
    expect(result).not.toHaveProperty('user_id')
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
    const upsertCalls = []
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
      // Stands in for ON CONFLICT DO UPDATE: the conflict resolves to the
      // existing row, so the returned row carries that row's id whether or not
      // the payload mentioned one.
      upsert: vi.fn(function (rows) {
        upsertCalls.push(rows)
        return {
          select: vi.fn().mockResolvedValue({
            data: rows.map(row => ({ ...row, id: 'existing-1' })),
            error: null,
          }),
        }
      }),
    }))

    const result = await additiveSaveOwnedCards([
      { card_print_id: 'cp-1', user_id: 'user-A', qty: 2, foil: false },
    ])
    expect(result[0].qty).toBe(6) // 4 existing + 2 new
    expect(result[0].id).toBe('existing-1') // still points at the existing card
    expect(result[0].purchase_price).toBe(1.50) // preserves existing price
    // The payload must not carry an id: DO UPDATE writes every column it is
    // given, so an id there rewrites the primary key of a row that
    // deck_allocations/folder_cards reference (both ON UPDATE NO ACTION).
    expect(upsertCalls[0][0]).not.toHaveProperty('id')
  })

  it('never sends an id for a brand-new row either', async () => {
    const upsertCalls = []
    sb.from.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
      upsert: vi.fn(function (rows) {
        upsertCalls.push(rows)
        return { select: vi.fn().mockResolvedValue({ data: rows, error: null }) }
      }),
    }))

    await additiveSaveOwnedCards([{ card_print_id: 'cp-9', user_id: 'user-A', qty: 1, foil: false }])

    expect(upsertCalls[0][0]).not.toHaveProperty('id')
  })
})

describe('additiveSaveWishlistItems', () => {
  // from().select().eq().in() → existing wishlist rows; from().upsert().select() → saved.
  const mockListItems = (existing) => {
    const upsertCalls = []
    sb.from.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({ data: existing, error: null }),
      upsert: vi.fn(function (rows) {
        upsertCalls.push(rows)
        return { select: vi.fn().mockResolvedValue({ data: rows, error: null }) }
      }),
    }))
    return upsertCalls
  }

  it('adds to the qty already on the wishlist instead of replacing it', async () => {
    // The scanner used to upsert a raw qty on (folder_id, card_print_id, foil),
    // so re-scanning a card you already wanted 3 of overwrote the 3.
    const upsertCalls = mockListItems([{ card_print_id: 'cp-1', foil: false, qty: 3 }])
    await additiveSaveWishlistItems('f1', 'u1', [{ card_print_id: 'cp-1', foil: false, qty: 2 }])
    expect(upsertCalls[0][0].qty).toBe(5)
  })

  it('does not add a foil want onto the non-foil row', async () => {
    const upsertCalls = mockListItems([{ card_print_id: 'cp-1', foil: false, qty: 3 }])
    await additiveSaveWishlistItems('f1', 'u1', [{ card_print_id: 'cp-1', foil: true, qty: 2 }])
    expect(upsertCalls[0][0].qty).toBe(2)
  })

  it('merges duplicate input rows before comparing against the wishlist', async () => {
    const upsertCalls = mockListItems([{ card_print_id: 'cp-1', foil: false, qty: 1 }])
    await additiveSaveWishlistItems('f1', 'u1', [
      { card_print_id: 'cp-1', foil: false, qty: 2 },
      { card_print_id: 'cp-1', foil: false, qty: 4 },
    ])
    expect(upsertCalls[0]).toHaveLength(1)
    expect(upsertCalls[0][0].qty).toBe(7)
  })

  it('stamps folder_id and user_id onto every row', async () => {
    const upsertCalls = mockListItems([])
    await additiveSaveWishlistItems('f1', 'u1', [{ card_print_id: 'cp-1', foil: false, qty: 1 }])
    expect(upsertCalls[0][0]).toMatchObject({ folder_id: 'f1', user_id: 'u1' })
  })

  it('rejects a row whose printing could not be resolved', async () => {
    // list_items.card_print_id is NOT NULL — better a readable message than a
    // constraint violation mid-batch.
    mockListItems([])
    await expect(
      additiveSaveWishlistItems('f1', 'u1', [{ name: 'Sol Ring', foil: false, qty: 1 }], 'Scanned card')
    ).rejects.toThrow(/Scanned card could not resolve a card print for Sol Ring/)
  })
})

describe('resolvePurchasePrice', () => {
  it('keeps the stored cost basis when the caller supplied none', () => {
    // The scanner and plain decklist imports send 0 because they have no price,
    // not because the card was free. Letting that win would erase what the card
    // cost — and worse than erase it: the BEFORE INSERT trigger fills
    // `excluded.purchase_price` with today's market price before the conflict
    // resolves, so the stored value would be replaced by today's, silently.
    expect(resolvePurchasePrice(0, 3.5)).toBe(3.5)
    expect(resolvePurchasePrice(undefined, 3.5)).toBe(3.5)
    expect(resolvePurchasePrice(null, 3.5)).toBe(3.5)
    expect(resolvePurchasePrice('', 3.5)).toBe(3.5)
  })

  it('lets a supplied price win over the stored one', () => {
    expect(resolvePurchasePrice(9.99, 3.5)).toBe(9.99)
    expect(resolvePurchasePrice('9.99', 3.5)).toBe(9.99)
  })

  it('returns 0 when neither side has a price, so the trigger fills it', () => {
    expect(resolvePurchasePrice(0, 0)).toBe(0)
    expect(resolvePurchasePrice(undefined, undefined)).toBe(0)
    expect(resolvePurchasePrice('abc', null)).toBe(0)
  })
})

describe('buildOwnedCardUpsertRows', () => {
  const keyOf = row => `${row.card_print_id}|${row.foil ? 1 : 0}`

  it('omits id for new rows and for rows merged onto an existing card', () => {
    const existingByKey = new Map([['cp-1|0', {
      id: 'existing-1', user_id: 'u', card_print_id: 'cp-1', foil: false, qty: 4, purchase_price: 2,
    }]])
    const rows = buildOwnedCardUpsertRows([
      { user_id: 'u', card_print_id: 'cp-1', foil: false, qty: 2 },
      { user_id: 'u', card_print_id: 'cp-2', foil: false, qty: 1 },
    ], existingByKey, keyOf)

    expect(rows[0]).not.toHaveProperty('id')
    expect(rows[1]).not.toHaveProperty('id')
    expect(rows[0].qty).toBe(6)               // 4 existing + 2 new
    expect(rows[0].purchase_price).toBe(2)    // existing metadata carried over
    expect(rows[1].qty).toBe(1)
  })

  it('does not let a priceless incoming row wipe the stored purchase price', () => {
    const existingByKey = new Map([['cp-1|0', {
      id: 'existing-1', user_id: 'u', card_print_id: 'cp-1', foil: false, qty: 4, purchase_price: 7.25,
    }]])
    // What the scanner and AddCardModal send when no price was resolved.
    const rows = buildOwnedCardUpsertRows(
      [{ user_id: 'u', card_print_id: 'cp-1', foil: false, qty: 1, purchase_price: 0 }],
      existingByKey, keyOf,
    )
    expect(rows[0].purchase_price).toBe(7.25)
  })

  it('lets a typed purchase price replace the stored one', () => {
    const existingByKey = new Map([['cp-1|0', {
      id: 'existing-1', user_id: 'u', card_print_id: 'cp-1', foil: false, qty: 4, purchase_price: 7.25,
    }]])
    const rows = buildOwnedCardUpsertRows(
      [{ user_id: 'u', card_print_id: 'cp-1', foil: false, qty: 1, purchase_price: 12.5 }],
      existingByKey, keyOf,
    )
    expect(rows[0].purchase_price).toBe(12.5)
  })

  it('treats a missing existing map as all-new', () => {
    const rows = buildOwnedCardUpsertRows(
      [{ card_print_id: 'cp-1', foil: false, qty: 3, id: 'stale' }], undefined, keyOf,
    )
    expect(rows[0]).not.toHaveProperty('id')
    expect(rows[0].qty).toBe(3)
  })

  it('returns [] for empty input', () => {
    expect(buildOwnedCardUpsertRows(null, new Map(), keyOf)).toEqual([])
  })
})
