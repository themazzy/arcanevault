import { describe, it, expect } from 'vitest'
import { shouldInsertPrint, buildPrintRow, ORACLE_TEXT_CAP } from '../../scripts/lib/print-sync-core.mjs'

function bulkCard(overrides = {}) {
  return {
    object: 'card',
    id: 'abc-123',
    oracle_id: 'oracle-1',
    name: 'Lightning Bolt',
    set: 'clu',
    collector_number: '141',
    lang: 'en',
    layout: 'normal',
    set_type: 'expansion',
    games: ['paper', 'mtgo'],
    digital: false,
    type_line: 'Instant',
    mana_cost: '{R}',
    cmc: 1,
    color_identity: ['R'],
    colors: ['R'],
    keywords: [],
    produced_mana: null,
    rarity: 'uncommon',
    set_name: 'Ravnica: Clue Edition',
    artist: 'Christopher Moeller',
    released_at: '2024-02-23',
    edhrec_rank: 52,
    illustration_id: 'illus-1',
    finishes: ['nonfoil', 'foil'],
    image_uris: {
      small: 'https://cards.scryfall.io/small/front/a/b/abc-123.jpg',
      normal: 'https://cards.scryfall.io/normal/front/a/b/abc-123.jpg',
      art_crop: 'https://cards.scryfall.io/art_crop/front/a/b/abc-123.jpg',
    },
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    prices: { eur: '1.50' },
    ...overrides,
  }
}

describe('shouldInsertPrint', () => {
  it('accepts a normal English paper card', () => {
    expect(shouldInsertPrint(bulkCard())).toBe(true)
  })

  it('accepts cards without a price (new set previews)', () => {
    expect(shouldInsertPrint(bulkCard({ prices: {} }))).toBe(true)
  })

  it('rejects non-English prints', () => {
    expect(shouldInsertPrint(bulkCard({ lang: 'de' }))).toBe(false)
  })

  it('rejects digital-only cards', () => {
    expect(shouldInsertPrint(bulkCard({ digital: true }))).toBe(false)
    expect(shouldInsertPrint(bulkCard({ games: ['arena', 'mtgo'] }))).toBe(false)
  })

  it('accepts cards with an empty games array (previews)', () => {
    expect(shouldInsertPrint(bulkCard({ games: [] }))).toBe(true)
  })

  it('rejects excluded layouts and set types', () => {
    expect(shouldInsertPrint(bulkCard({ layout: 'token' }))).toBe(false)
    expect(shouldInsertPrint(bulkCard({ layout: 'art_series' }))).toBe(false)
    expect(shouldInsertPrint(bulkCard({ set_type: 'memorabilia' }))).toBe(false)
    expect(shouldInsertPrint(bulkCard({ set_type: 'alchemy' }))).toBe(false)
  })

  it('rejects rows missing identity fields', () => {
    expect(shouldInsertPrint(bulkCard({ id: null }))).toBe(false)
    expect(shouldInsertPrint(bulkCard({ set: null }))).toBe(false)
    expect(shouldInsertPrint(bulkCard({ collector_number: null }))).toBe(false)
    expect(shouldInsertPrint(bulkCard({ object: 'error' }))).toBe(false)
  })
})

describe('buildPrintRow', () => {
  it('maps bulk fields to card_prints columns', () => {
    const row = buildPrintRow(bulkCard())
    expect(row).toMatchObject({
      scryfall_id: 'abc-123',
      oracle_id: 'oracle-1',
      name: 'Lightning Bolt',
      set_code: 'clu',
      collector_number: '141',
      lang: 'en',
      rarity: 'uncommon',
      released_at: '2024-02-23',
      edhrec_rank: 52,
      illustration_id: 'illus-1',
      finishes: ['nonfoil', 'foil'],
      image_uri: 'https://cards.scryfall.io/normal/front/a/b/abc-123.jpg',
      art_crop_uri: 'https://cards.scryfall.io/art_crop/front/a/b/abc-123.jpg',
    })
    expect(row.produced_mana).toEqual([])
    expect(row.card_faces).toBeNull()
  })

  it('falls back to face data for DFC image, mana cost, and illustration', () => {
    const row = buildPrintRow(bulkCard({
      image_uris: undefined,
      mana_cost: undefined,
      illustration_id: undefined,
      oracle_text: undefined,
      card_faces: [
        {
          name: 'Delver of Secrets',
          mana_cost: '{U}',
          type_line: 'Creature — Human Wizard',
          oracle_text: 'Front text.',
          illustration_id: 'face-illus',
          image_uris: { small: 's1', normal: 'n1', large: 'l1' },
        },
        {
          name: 'Insectile Aberration',
          mana_cost: '',
          type_line: 'Creature — Human Insect',
          oracle_text: 'Back text.',
          image_uris: { small: 's2', normal: 'n2', large: 'l2' },
        },
      ],
    }))
    expect(row.image_uri).toBe('n1')
    expect(row.mana_cost).toBe('{U}')
    expect(row.illustration_id).toBe('face-illus')
    expect(row.oracle_text).toBe('Front text.\n//\nBack text.')
    expect(row.card_faces).toHaveLength(2)
    expect(row.card_faces[0]).toMatchObject({ name: 'Delver of Secrets', oracle_text: 'Front text.' })
  })

  it('caps oracle text and nulls non-finite edhrec ranks', () => {
    const row = buildPrintRow(bulkCard({
      oracle_text: 'x'.repeat(ORACLE_TEXT_CAP + 100),
      edhrec_rank: undefined,
      finishes: undefined,
    }))
    expect(row.oracle_text).toHaveLength(ORACLE_TEXT_CAP)
    expect(row.edhrec_rank).toBeNull()
    expect(row.finishes).toEqual([])
  })
})
