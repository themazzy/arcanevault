import { describe, it, expect } from 'vitest'
import { buildImageUris, rowToCard, priceRowToPrices, mergePriceRows } from './cardSearch'

const NORMAL_URL = 'https://cards.scryfall.io/normal/front/a/b/abc-123.jpg'

describe('buildImageUris', () => {
  it('derives all sizes from the stored normal URL', () => {
    const uris = buildImageUris(NORMAL_URL, null)
    expect(uris.normal).toBe(NORMAL_URL)
    expect(uris.small).toBe('https://cards.scryfall.io/small/front/a/b/abc-123.jpg')
    expect(uris.large).toBe('https://cards.scryfall.io/large/front/a/b/abc-123.jpg')
    expect(uris.art_crop).toBe('https://cards.scryfall.io/art_crop/front/a/b/abc-123.jpg')
  })

  it('prefers the stored art_crop URL when present', () => {
    const uris = buildImageUris(NORMAL_URL, 'https://cards.scryfall.io/art_crop/front/a/b/xyz.jpg')
    expect(uris.art_crop).toBe('https://cards.scryfall.io/art_crop/front/a/b/xyz.jpg')
  })

  it('returns null when no image is stored', () => {
    expect(buildImageUris(null, null)).toBeNull()
  })
})

describe('rowToCard', () => {
  const row = {
    scryfall_id: 'abc-123',
    oracle_id: 'oracle-1',
    name: 'Lightning Bolt',
    set_code: 'clu',
    set_name: 'Ravnica: Clue Edition',
    collector_number: '141',
    lang: 'en',
    rarity: 'uncommon',
    released_at: '2024-02-23',
    type_line: 'Instant',
    mana_cost: '{R}',
    cmc: 1,
    color_identity: ['R'],
    image_uri: NORMAL_URL,
    art_crop_uri: null,
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    card_faces: null,
    edhrec_rank: 52,
    finishes: ['nonfoil', 'foil'],
  }

  it('maps a card_prints row to Scryfall shape', () => {
    const card = rowToCard(row)
    expect(card).toMatchObject({
      object: 'card',
      id: 'abc-123',
      name: 'Lightning Bolt',
      set: 'clu',
      set_name: 'Ravnica: Clue Edition',
      collector_number: '141',
      rarity: 'uncommon',
      released_at: '2024-02-23',
      type_line: 'Instant',
      mana_cost: '{R}',
      cmc: 1,
      edhrec_rank: 52,
    })
    expect(card.image_uris.normal).toBe(NORMAL_URL)
    expect(card.image_uris.small).toContain('/small/')
  })

  it('defaults array fields and rejects rows without a name', () => {
    const card = rowToCard({ name: 'X', scryfall_id: 'id-1' })
    expect(card.color_identity).toEqual([])
    expect(card.keywords).toEqual([])
    expect(card.finishes).toEqual([])
    expect(card.image_uris).toBeNull()
    expect(rowToCard(null)).toBeNull()
    expect(rowToCard({ scryfall_id: 'no-name' })).toBeNull()
  })

  it('passes stored card_faces through untouched', () => {
    const faces = [{ name: 'Front', image_uris: { normal: 'n1' } }]
    expect(rowToCard({ ...row, card_faces: faces }).card_faces).toBe(faces)
  })
})

describe('priceRowToPrices / mergePriceRows', () => {
  const today = '2026-07-09'
  const yesterday = '2026-07-08'

  it('maps price columns to Scryfall price keys, dropping nulls', () => {
    expect(priceRowToPrices({
      price_regular_eur: 1.5,
      price_foil_eur: null,
      price_regular_usd: 1.75,
      price_foil_usd: 4,
    })).toEqual({ eur: 1.5, usd: 1.75, usd_foil: 4 })
  })

  it("attaches today's prices and yesterday's as prices_prev", () => {
    const cards = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
    const rows = [
      { scryfall_id: 'a', snapshot_date: today, price_regular_eur: 2 },
      { scryfall_id: 'a', snapshot_date: yesterday, price_regular_eur: 1 },
      { scryfall_id: 'b', snapshot_date: yesterday, price_regular_eur: 5 },
    ]
    const [a, b] = mergePriceRows(cards, rows, today)
    expect(a.prices).toEqual({ eur: 2 })
    expect(a.prices_prev).toEqual({ eur: 1 })
    // only yesterday's row exists → used as current, no prev
    expect(b.prices).toEqual({ eur: 5 })
    expect(b.prices_prev).toBeUndefined()
  })

  it('leaves cards without price rows untouched', () => {
    const cards = [{ id: 'c', name: 'C' }]
    const [c] = mergePriceRows(cards, [], today)
    expect(c.prices).toBeUndefined()
  })
})
