import { describe, it, expect } from 'vitest'
import {
  applyFilterSort,
  matchNumeric,
  getPrice,
  getPriceStrict,
  RARITY_ORDER,
} from './filterCore'

// ── Test fixtures ────────────────────────────────────────────────────────────
// Build a minimal card row + sfMap pair. The keys here mirror what
// CardComponents and the filter worker actually pass in production.

function card(overrides = {}) {
  return {
    id: 'c1',
    name: 'Bolt',
    set_code: 'lea',
    collector_number: '1',
    foil: false,
    condition: 'near_mint',
    language: 'en',
    qty: 1,
    altered: false,
    misprint: false,
    purchase_price: null,
    added_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function sf(overrides = {}) {
  return {
    type_line: 'Instant',
    oracle_text: 'Deal 3 damage to any target.',
    artist: 'Christopher Rush',
    rarity: 'common',
    color_identity: ['R'],
    cmc: 1,
    power: null,
    toughness: null,
    legalities: { modern: 'legal', commander: 'legal', standard: 'not_legal' },
    prices: { eur: '1.50', eur_foil: '5.00', usd: '1.80', usd_foil: '6.00', tix: '0.10', usd_etched: null },
    set_name: 'Limited Edition Alpha',
    ...overrides,
  }
}

function makeMap(entries) {
  const sfMap = {}
  for (const [c, s] of entries) {
    sfMap[`${c.set_code}-${c.collector_number}`] = s
  }
  return sfMap
}

// ── matchNumeric ─────────────────────────────────────────────────────────────

describe('matchNumeric', () => {
  it('returns true for any op regardless of value', () => {
    expect(matchNumeric('5', 'any', '0', '0')).toBe(true)
    expect(matchNumeric('not-a-number', 'any', '0', '0')).toBe(true)
  })

  it('NaN value with op != any returns false', () => {
    expect(matchNumeric('*', '=', '3', '')).toBe(false)
    expect(matchNumeric(undefined, '>', '0', '')).toBe(false)
  })

  it('handles = < <= > >= operators', () => {
    expect(matchNumeric('3', '=', '3', '')).toBe(true)
    expect(matchNumeric('3', '=', '4', '')).toBe(false)
    expect(matchNumeric('3', '<', '5', '')).toBe(true)
    expect(matchNumeric('5', '<', '5', '')).toBe(false)
    expect(matchNumeric('5', '<=', '5', '')).toBe(true)
    expect(matchNumeric('6', '>', '5', '')).toBe(true)
    expect(matchNumeric('5', '>=', '5', '')).toBe(true)
  })

  it('handles between as inclusive range', () => {
    expect(matchNumeric('3', 'between', '2', '4')).toBe(true)
    expect(matchNumeric('2', 'between', '2', '4')).toBe(true)
    expect(matchNumeric('4', 'between', '2', '4')).toBe(true)
    expect(matchNumeric('1', 'between', '2', '4')).toBe(false)
    expect(matchNumeric('5', 'between', '2', '4')).toBe(false)
  })

  it('handles in as exact membership in comma list', () => {
    expect(matchNumeric('3', 'in', '1,3,5', '')).toBe(true)
    expect(matchNumeric('2', 'in', '1,3,5', '')).toBe(false)
    expect(matchNumeric('3', 'in', '', '')).toBe(false)
  })

  it('returns false if min is missing for ops that need it', () => {
    expect(matchNumeric('3', '=', '', '')).toBe(false)
    expect(matchNumeric('3', 'between', '', '4')).toBe(false)
  })
})

// ── getPrice / getPriceStrict ────────────────────────────────────────────────

describe('getPrice (cross-source fallback)', () => {
  it('returns null when prices missing', () => {
    expect(getPrice(null, false)).toBeNull()
    expect(getPrice({}, false)).toBeNull()
    expect(getPrice({ prices: null }, false)).toBeNull()
  })

  it('returns selected price source', () => {
    const s = sf({ prices: { eur: '1.50', usd: '2.00', tix: '0.10' } })
    expect(getPrice(s, false, 'cardmarket_trend')).toBe(1.5)
    expect(getPrice(s, false, 'tcgplayer_market')).toBe(2)
    expect(getPrice(s, false, 'mtgo_tix')).toBe(0.1)
  })

  it('returns foil price when foil flag set', () => {
    const s = sf({ prices: { eur: '1.50', eur_foil: '5.00' } })
    expect(getPrice(s, true, 'cardmarket_trend')).toBe(5)
  })

  it('falls back to other sources when preferred is missing', () => {
    const s = sf({ prices: { eur: null, usd: '2.00', tix: null } })
    expect(getPrice(s, false, 'cardmarket_trend')).toBe(2)
  })

  it('unknown source falls back to cardmarket_trend behavior', () => {
    const s = sf({ prices: { eur: '1.50', usd: '2.00' } })
    expect(getPrice(s, false, 'nonexistent_source')).toBe(1.5)
  })
})

describe('getPriceStrict (no fallback)', () => {
  it('returns null if the requested field is missing', () => {
    const s = sf({ prices: { eur: null, usd: '2.00' } })
    expect(getPriceStrict(s, false, 'cardmarket_trend')).toBeNull()
    expect(getPriceStrict(s, false, 'tcgplayer_market')).toBe(2)
  })

  it('uses foil field when foil flag set', () => {
    const s = sf({ prices: { eur: '1.50', eur_foil: '5.00' } })
    expect(getPriceStrict(s, true, 'cardmarket_trend')).toBe(5)
  })

  it('returns null when prices missing', () => {
    expect(getPriceStrict(null, false)).toBeNull()
  })
})

// ── applyFilterSort: minimal smoke ───────────────────────────────────────────

describe('applyFilterSort — defaults', () => {
  it('returns all cards when no filters/search/sort given', () => {
    const c1 = card({ id: '1', name: 'Bolt', set_code: 'lea', collector_number: '1' })
    const c2 = card({ id: '2', name: 'Counterspell', set_code: 'lea', collector_number: '2' })
    const sfMap = makeMap([[c1, sf()], [c2, sf({ type_line: 'Instant', color_identity: ['U'] })]])
    const r = applyFilterSort([c1, c2], sfMap)
    expect(r.length).toBe(2)
  })

  it('does not mutate the input array', () => {
    const c1 = card({ id: '1', name: 'B' })
    const c2 = card({ id: '2', name: 'A' })
    const cards = [c1, c2]
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    applyFilterSort(cards, sfMap, { sort: 'name' })
    expect(cards.map(c => c.id)).toEqual(['1', '2'])
  })

  it('does not leak __sk sort-key marker onto returned rows', () => {
    const c1 = card({ id: '1' })
    const sfMap = makeMap([[c1, sf()]])
    const [out] = applyFilterSort([c1], sfMap, { sort: 'name' })
    expect('__sk' in out).toBe(false)
  })
})

// ── applyFilterSort: each individual filter ──────────────────────────────────

describe('applyFilterSort — foil filter', () => {
  const foilCard = card({ id: 'f', foil: true })
  const normalCard = card({ id: 'n', foil: false })
  const sfMap = makeMap([[foilCard, sf()], [normalCard, sf()]])

  it('foil=all returns both', () => {
    expect(applyFilterSort([foilCard, normalCard], sfMap, { filters: { foil: 'all' } }).length).toBe(2)
  })
  it('foil=foil keeps only foils', () => {
    const r = applyFilterSort([foilCard, normalCard], sfMap, { filters: { foil: 'foil' } })
    expect(r.map(c => c.id)).toEqual(['f'])
  })
  it('foil=nonfoil drops foils', () => {
    const r = applyFilterSort([foilCard, normalCard], sfMap, { filters: { foil: 'nonfoil' } })
    expect(r.map(c => c.id)).toEqual(['n'])
  })
  it('foil=etched mirrors foil=foil (etched-as-foil semantics)', () => {
    const r = applyFilterSort([foilCard, normalCard], sfMap, { filters: { foil: 'etched' } })
    expect(r.map(c => c.id)).toEqual(['f'])
  })
})

describe('applyFilterSort — rarity / condition / language / set filters', () => {
  it('rarity filter uses sfMap entry', () => {
    const c1 = card({ id: '1', set_code: 'a', collector_number: '1' })
    const c2 = card({ id: '2', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [c1, sf({ rarity: 'mythic' })],
      [c2, sf({ rarity: 'common' })],
    ])
    expect(applyFilterSort([c1, c2], sfMap, { filters: { rarity: ['mythic'] } }).map(c => c.id)).toEqual(['1'])
  })

  it('conditions filter', () => {
    const c1 = card({ id: '1', condition: 'lightly_played' })
    const c2 = card({ id: '2', condition: 'damaged' })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { conditions: ['damaged'] } }).map(c => c.id),
    ).toEqual(['2'])
  })

  it('languages filter', () => {
    const c1 = card({ id: '1', language: 'en' })
    const c2 = card({ id: '2', language: 'ja' })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { languages: ['ja'] } }).map(c => c.id),
    ).toEqual(['2'])
  })

  it('sets filter', () => {
    const c1 = card({ id: '1', set_code: 'lea', collector_number: '1' })
    const c2 = card({ id: '2', set_code: 'mh3', collector_number: '1' })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    expect(applyFilterSort([c1, c2], sfMap, { filters: { sets: ['mh3'] } }).map(c => c.id)).toEqual(['2'])
  })
})

describe('applyFilterSort — quantity / specials / location', () => {
  it('quantity=dupes keeps qty > 1', () => {
    const c1 = card({ id: '1', qty: 1 })
    const c2 = card({ id: '2', qty: 3 })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    expect(applyFilterSort([c1, c2], sfMap, { filters: { quantity: 'dupes' } }).map(c => c.id)).toEqual(['2'])
  })

  it('quantity=single keeps qty === 1', () => {
    const c1 = card({ id: '1', qty: 1 })
    const c2 = card({ id: '2', qty: 3 })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    expect(applyFilterSort([c1, c2], sfMap, { filters: { quantity: 'single' } }).map(c => c.id)).toEqual(['1'])
  })

  it('useFolderQty=true respects _folder_qty over c.qty', () => {
    const c1 = card({ id: '1', qty: 5, _folder_qty: 1 })
    const c2 = card({ id: '2', qty: 1, _folder_qty: 3 })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { quantity: 'dupes' }, useFolderQty: true }).map(c => c.id),
    ).toEqual(['2'])
  })

  it('useFolderQty=false ignores _folder_qty (worker mode)', () => {
    const c1 = card({ id: '1', qty: 5, _folder_qty: 1 })
    const c2 = card({ id: '2', qty: 1, _folder_qty: 3 })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { quantity: 'dupes' }, useFolderQty: false }).map(c => c.id),
    ).toEqual(['1'])
  })

  it('specials=altered / misprint flags', () => {
    const c1 = card({ id: '1', altered: true })
    const c2 = card({ id: '2', misprint: true })
    const c3 = card({ id: '3' })
    const sfMap = makeMap([[c1, sf()], [c2, sf()], [c3, sf()]])
    expect(
      applyFilterSort([c1, c2, c3], sfMap, { filters: { specials: ['altered'] } }).map(c => c.id),
    ).toEqual(['1'])
    expect(
      applyFilterSort([c1, c2, c3], sfMap, { filters: { specials: ['misprint'] } }).map(c => c.id),
    ).toEqual(['2'])
  })

  it('location=binder / deck uses cardFolderMap', () => {
    const c1 = card({ id: '1' })
    const c2 = card({ id: '2' })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    const cardFolderMap = {
      '1': [{ id: 'f1', name: 'My Binder', type: 'binder', qty: 1 }],
      '2': [{ id: 'f2', name: 'My Deck', type: 'deck', qty: 1 }],
    }
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { location: 'binder' }, cardFolderMap }).map(c => c.id),
    ).toEqual(['1'])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { location: 'deck' }, cardFolderMap }).map(c => c.id),
    ).toEqual(['2'])
  })

  it('folderName matches case-insensitively against binder/deck names', () => {
    const c1 = card({ id: '1' })
    const c2 = card({ id: '2' })
    const sfMap = makeMap([[c1, sf()], [c2, sf()]])
    const cardFolderMap = {
      '1': [{ id: 'f1', name: 'Burn Deck', type: 'deck', qty: 1 }],
      '2': [{ id: 'f2', name: 'Vintage Cube', type: 'binder', qty: 1 }],
    }
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { folderName: 'burn' }, cardFolderMap }).map(c => c.id),
    ).toEqual(['1'])
  })
})

describe('applyFilterSort — text filters', () => {
  it('typeLine requires ALL tokens to appear (AND semantics)', () => {
    const c1 = card({ id: '1', set_code: 'a', collector_number: '1' })
    const c2 = card({ id: '2', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [c1, sf({ type_line: 'Legendary Creature — Goblin' })],
      [c2, sf({ type_line: 'Creature — Goblin Warrior' })],
    ])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { typeLine: ['legendary', 'goblin'] } }).map(c => c.id),
    ).toEqual(['1'])
  })

  it('oracleText substring match', () => {
    const c1 = card({ id: '1' })
    const c2 = card({ id: '2', set_code: 'lea', collector_number: '2' })
    const sfMap = makeMap([
      [c1, sf({ oracle_text: 'Counter target spell.' })],
      [c2, sf({ oracle_text: 'Draw a card.' })],
    ])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { oracleText: 'counter' } }).map(c => c.id),
    ).toEqual(['1'])
  })

  it('artist substring match', () => {
    const c1 = card({ id: '1' })
    const c2 = card({ id: '2', set_code: 'lea', collector_number: '2' })
    const sfMap = makeMap([
      [c1, sf({ artist: 'Rebecca Guay' })],
      [c2, sf({ artist: 'John Avon' })],
    ])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { artist: 'guay' } }).map(c => c.id),
    ).toEqual(['1'])
  })

  it('search matches name OR set_code OR set_name', () => {
    const c1 = card({ id: '1', name: 'Bolt', set_code: 'lea' })
    const c2 = card({ id: '2', name: 'Counterspell', set_code: 'mh3', collector_number: '2' })
    const sfMap = makeMap([
      [c1, sf({ set_name: 'Limited Edition Alpha' })],
      [c2, sf({ set_name: 'Modern Horizons 3' })],
    ])
    expect(applyFilterSort([c1, c2], sfMap, { search: 'bolt' }).map(c => c.id)).toEqual(['1'])
    expect(applyFilterSort([c1, c2], sfMap, { search: 'mh3' }).map(c => c.id)).toEqual(['2'])
    expect(applyFilterSort([c1, c2], sfMap, { search: 'horizons' }).map(c => c.id)).toEqual(['2'])
  })
})

describe('applyFilterSort — color filters', () => {
  function build() {
    const colorless = card({ id: 'col', set_code: 'a', collector_number: '1' })
    const mono = card({ id: 'mono', set_code: 'a', collector_number: '2' })
    const izzet = card({ id: 'izzet', set_code: 'a', collector_number: '3' })
    const sfMap = makeMap([
      [colorless, sf({ color_identity: [] })],
      [mono, sf({ color_identity: ['R'] })],
      [izzet, sf({ color_identity: ['U', 'R'] })],
    ])
    return { cards: [colorless, mono, izzet], sfMap }
  }

  it('colors=[C] keeps only colorless cards', () => {
    const { cards, sfMap } = build()
    expect(applyFilterSort(cards, sfMap, { filters: { colors: ['C'] } }).map(c => c.id)).toEqual(['col'])
  })

  it('colors=[M] keeps only multi-color (id length > 1)', () => {
    const { cards, sfMap } = build()
    expect(applyFilterSort(cards, sfMap, { filters: { colors: ['M'] } }).map(c => c.id)).toEqual(['izzet'])
  })

  it('colors=[R] mode=exact requires id === [R]', () => {
    const { cards, sfMap } = build()
    expect(
      applyFilterSort(cards, sfMap, { filters: { colors: ['R'], colorMode: 'exact' } }).map(c => c.id),
    ).toEqual(['mono'])
  })

  it('colors=[R] mode=including matches any card containing R', () => {
    const { cards, sfMap } = build()
    expect(
      applyFilterSort(cards, sfMap, { filters: { colors: ['R'], colorMode: 'including' } }).map(c => c.id),
    ).toEqual(['mono', 'izzet'])
  })

  it('colorCountMin/Max bounds work', () => {
    const { cards, sfMap } = build()
    expect(
      applyFilterSort(cards, sfMap, { filters: { colorCountMin: 2 } }).map(c => c.id),
    ).toEqual(['izzet'])
    expect(
      applyFilterSort(cards, sfMap, { filters: { colorCountMax: 0 } }).map(c => c.id),
    ).toEqual(['col'])
  })
})

describe('applyFilterSort — format legality', () => {
  it('keeps cards legal in any selected format', () => {
    const c1 = card({ id: 'std' })
    const c2 = card({ id: 'mod', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [c1, sf({ legalities: { standard: 'legal', modern: 'not_legal' } })],
      [c2, sf({ legalities: { standard: 'not_legal', modern: 'legal' } })],
    ])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { formats: ['standard'] } }).map(c => c.id),
    ).toEqual(['std'])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { formats: ['modern'] } }).map(c => c.id),
    ).toEqual(['mod'])
    expect(
      applyFilterSort([c1, c2], sfMap, { filters: { formats: ['standard', 'modern'] } }).map(c => c.id).sort(),
    ).toEqual(['mod', 'std'])
  })
})

describe('applyFilterSort — numeric filters (cmc / power / toughness)', () => {
  it('cmc with each op', () => {
    const c1 = card({ id: '1' })
    const c2 = card({ id: '2', set_code: 'a', collector_number: '2' })
    const c3 = card({ id: '3', set_code: 'a', collector_number: '3' })
    const sfMap = makeMap([
      [c1, sf({ cmc: 1 })],
      [c2, sf({ cmc: 3 })],
      [c3, sf({ cmc: 5 })],
    ])
    expect(
      applyFilterSort([c1, c2, c3], sfMap, { filters: { cmcOp: '=', cmcMin: '3' } }).map(c => c.id),
    ).toEqual(['2'])
    expect(
      applyFilterSort([c1, c2, c3], sfMap, { filters: { cmcOp: 'between', cmcMin: '2', cmcMax: '4' } }).map(c => c.id),
    ).toEqual(['2'])
    expect(
      applyFilterSort([c1, c2, c3], sfMap, { filters: { cmcOp: '<=', cmcMin: '3' } }).map(c => c.id),
    ).toEqual(['1', '2'])
  })

  it('power op skips cards without power (matchNumeric NaN → false unless any)', () => {
    const land = card({ id: 'land' })
    const creature = card({ id: 'cre', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [land, sf({ power: null })],
      [creature, sf({ power: '3' })],
    ])
    expect(
      applyFilterSort([land, creature], sfMap, { filters: { powerOp: '>=', powerVal: '1' } }).map(c => c.id),
    ).toEqual(['cre'])
  })
})

describe('applyFilterSort — price filter', () => {
  it('priceMin only includes cards above threshold', () => {
    const cheap = card({ id: 'cheap' })
    const pricey = card({ id: 'pricey', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [cheap, sf({ prices: { eur: '0.50' } })],
      [pricey, sf({ prices: { eur: '50.00' } })],
    ])
    expect(
      applyFilterSort([cheap, pricey], sfMap, { filters: { priceMin: '10' } }).map(c => c.id),
    ).toEqual(['pricey'])
  })

  it('falls back to purchase_price when price source missing', () => {
    const c1 = card({ id: '1', purchase_price: 7 })
    const sfMap = makeMap([[c1, sf({ prices: { eur: null } })]])
    expect(
      applyFilterSort([c1], sfMap, { filters: { priceMin: '5' } }).map(c => c.id),
    ).toEqual(['1'])
  })

  it('strictPrice=true does NOT cross-source-fallback', () => {
    // eur is null, usd has value — strict mode should reject when filtering on EUR.
    const c1 = card({ id: '1', purchase_price: null })
    const sfMap = makeMap([[c1, sf({ prices: { eur: null, usd: '20.00' } })]])
    const fallback = applyFilterSort([c1], sfMap, {
      filters: { priceMin: '5' },
      priceSource: 'cardmarket_trend',
      strictPrice: false,
    })
    const strict = applyFilterSort([c1], sfMap, {
      filters: { priceMin: '5' },
      priceSource: 'cardmarket_trend',
      strictPrice: true,
    })
    expect(fallback.map(c => c.id)).toEqual(['1'])
    expect(strict.map(c => c.id)).toEqual([])
  })
})

// ── applyFilterSort: sorts ───────────────────────────────────────────────────

describe('applyFilterSort — sort modes', () => {
  it('sort=name uses localeCompare ascending', () => {
    const a = card({ id: 'a', name: 'Aether Vial' })
    const b = card({ id: 'b', name: 'Bolt', set_code: 'a', collector_number: '2' })
    const c = card({ id: 'c', name: 'Counterspell', set_code: 'a', collector_number: '3' })
    const sfMap = makeMap([[a, sf()], [b, sf()], [c, sf()]])
    expect(applyFilterSort([c, a, b], sfMap, { sort: 'name' }).map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('sort=price_desc puts highest first', () => {
    const lo = card({ id: 'lo' })
    const hi = card({ id: 'hi', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [lo, sf({ prices: { eur: '1.00' } })],
      [hi, sf({ prices: { eur: '100.00' } })],
    ])
    expect(applyFilterSort([lo, hi], sfMap, { sort: 'price_desc' }).map(c => c.id)).toEqual(['hi', 'lo'])
  })

  it('sort=price_asc puts lowest first', () => {
    const lo = card({ id: 'lo' })
    const hi = card({ id: 'hi', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [lo, sf({ prices: { eur: '1.00' } })],
      [hi, sf({ prices: { eur: '100.00' } })],
    ])
    expect(applyFilterSort([lo, hi], sfMap, { sort: 'price_asc' }).map(c => c.id)).toEqual(['lo', 'hi'])
  })

  it('sort=qty uses _folder_qty when useFolderQty=true', () => {
    const a = card({ id: 'a', qty: 1, _folder_qty: 4 })
    const b = card({ id: 'b', qty: 4, _folder_qty: 1 })
    const sfMap = makeMap([[a, sf()], [b, sf()]])
    expect(
      applyFilterSort([a, b], sfMap, { sort: 'qty', useFolderQty: true }).map(c => c.id),
    ).toEqual(['a', 'b'])
    expect(
      applyFilterSort([a, b], sfMap, { sort: 'qty', useFolderQty: false }).map(c => c.id),
    ).toEqual(['b', 'a'])
  })

  it('sort=set is alphabetical by set_code', () => {
    const a = card({ id: 'a', set_code: 'mh3' })
    const b = card({ id: 'b', set_code: 'lea', collector_number: '2' })
    const sfMap = makeMap([[a, sf()], [b, sf()]])
    expect(applyFilterSort([a, b], sfMap, { sort: 'set' }).map(c => c.id)).toEqual(['b', 'a'])
  })

  it('sort=added is newest-first by added_at', () => {
    const old = card({ id: 'old', added_at: '2020-01-01T00:00:00Z' })
    const recent = card({ id: 'rec', added_at: '2025-01-01T00:00:00Z', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([[old, sf()], [recent, sf()]])
    expect(applyFilterSort([old, recent], sfMap, { sort: 'added' }).map(c => c.id)).toEqual(['rec', 'old'])
  })

  it('sort=rarity follows RARITY_ORDER descending (mythic > rare > uncommon > common)', () => {
    expect(RARITY_ORDER.mythic).toBeGreaterThan(RARITY_ORDER.rare)
    const co = card({ id: 'co' })
    const my = card({ id: 'my', set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([[co, sf({ rarity: 'common' })], [my, sf({ rarity: 'mythic' })]])
    expect(applyFilterSort([co, my], sfMap, { sort: 'rarity' }).map(c => c.id)).toEqual(['my', 'co'])
  })

  it('sort=cmc_asc and cmc_desc', () => {
    const a = card({ id: 'a' })
    const b = card({ id: 'b', set_code: 'a', collector_number: '2' })
    const c = card({ id: 'c', set_code: 'a', collector_number: '3' })
    const sfMap = makeMap([
      [a, sf({ cmc: 4 })],
      [b, sf({ cmc: 1 })],
      [c, sf({ cmc: 7 })],
    ])
    expect(applyFilterSort([a, b, c], sfMap, { sort: 'cmc_asc' }).map(x => x.id)).toEqual(['b', 'a', 'c'])
    expect(applyFilterSort([a, b, c], sfMap, { sort: 'cmc_desc' }).map(x => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('sort=pl_desc orders by (price - purchase_price) * qty', () => {
    // Card A: bought at 1, worth 5, qty 2 → P/L = 8
    // Card B: bought at 2, worth 3, qty 3 → P/L = 3
    const a = card({ id: 'a', qty: 2, purchase_price: 1 })
    const b = card({ id: 'b', qty: 3, purchase_price: 2, set_code: 'a', collector_number: '2' })
    const sfMap = makeMap([
      [a, sf({ prices: { eur: '5.00' } })],
      [b, sf({ prices: { eur: '3.00' } })],
    ])
    expect(applyFilterSort([a, b], sfMap, { sort: 'pl_desc' }).map(c => c.id)).toEqual(['a', 'b'])
    expect(applyFilterSort([a, b], sfMap, { sort: 'pl_asc' }).map(c => c.id)).toEqual(['b', 'a'])
  })
})

// ── applyFilterSort: composition ─────────────────────────────────────────────

describe('applyFilterSort — combined filter + sort', () => {
  it('filter + sort compose correctly', () => {
    const a = card({ id: 'a', name: 'Z', foil: true })
    const b = card({ id: 'b', name: 'M', foil: false, set_code: 'a', collector_number: '2' })
    const c = card({ id: 'c', name: 'A', foil: true, set_code: 'a', collector_number: '3' })
    const sfMap = makeMap([[a, sf()], [b, sf()], [c, sf()]])
    const r = applyFilterSort([a, b, c], sfMap, { filters: { foil: 'foil' }, sort: 'name' })
    expect(r.map(x => x.id)).toEqual(['c', 'a'])
  })

  it('handles missing sfMap entries gracefully', () => {
    const c1 = card({ id: '1', set_code: 'unknown', collector_number: '999' })
    // sfMap intentionally has no entry for c1
    const out = applyFilterSort([c1], {}, { sort: 'name' })
    expect(out.map(c => c.id)).toEqual(['1'])
  })

  it('empty cards array returns empty', () => {
    expect(applyFilterSort([], {}, { sort: 'name' })).toEqual([])
  })
})
