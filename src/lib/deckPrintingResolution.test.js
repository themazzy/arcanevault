import { describe, expect, it } from 'vitest'
import {
  rankOwnedPrintingCandidates,
  resolveCanonicalDeckCardName,
  selectPreferredDeckPrinting,
  toAutomaticDeckPrintingRequest,
  toAutomaticDeckPrintingRequests,
} from './deckPrintingResolution'

const print = (id, releasedAt, extra = {}) => ({
  id,
  name: 'Lightning Bolt',
  set: id,
  collector_number: '1',
  lang: 'en',
  released_at: releasedAt,
  finishes: ['nonfoil', 'foil'],
  ...extra,
})

const owned = (printing, extra = {}) => ({
  id: `owned-${printing.id}`,
  scryfall_id: printing.id,
  set_code: printing.set,
  collector_number: printing.collector_number,
  card_print_id: `cp-${printing.id}`,
  binderQty: 0,
  deckQty: 0,
  foil: false,
  ...extra,
})

describe('deck printing resolution', () => {
  it('strips an owned suggestion printing down to a name-only request', () => {
    expect(toAutomaticDeckPrintingRequest({
      name: 'Sol Ring',
      id: 'search-print',
      scryfall_id: 'owned-print',
      card_print_id: 'card-print-row',
      set: 'lea',
      collector_number: '1',
      foil: true,
    })).toEqual({ name: 'Sol Ring' })
  })

  it('normalizes search and autofill batches to the same request contract', () => {
    expect(toAutomaticDeckPrintingRequests([
      { name: 'Arcane Signet', id: 'search-result', set: 'cmm' },
      { name: 'Swords to Plowshares', slug: 'swords-to-plowshares' },
      null,
    ])).toEqual([
      { name: 'Arcane Signet' },
      { name: 'Swords to Plowshares' },
    ])
  })

  it.each([
    ['MDFC', 'Bala Ged Recovery', 'Bala Ged Recovery // Bala Ged Sanctuary'],
    ['transform', 'Delver of Secrets', 'Delver of Secrets // Insectile Aberration'],
    ['flip', 'Budoka Gardener', 'Budoka Gardener // Dokai, Weaver of Life'],
    ['Adventure', 'Brazen Borrower', 'Brazen Borrower // Petty Theft'],
    ['split', 'Fire', 'Fire // Ice'],
    ['Battle', 'Invasion of Zendikar', 'Invasion of Zendikar // Awakened Skyclave'],
  ])('canonicalizes a %s front-face name before ownership lookup', (_layout, requested, canonical) => {
    expect(resolveCanonicalDeckCardName(requested, {
      metadata: { name: canonical },
    })).toBe(canonical)
  })

  it('canonicalizes a back-face lookup when face metadata is available', () => {
    expect(resolveCanonicalDeckCardName('Petty Theft', {
      metadata: {
        name: 'Brazen Borrower // Petty Theft',
        card_faces: [{ name: 'Brazen Borrower' }, { name: 'Petty Theft' }],
      },
    })).toBe('Brazen Borrower // Petty Theft')
  })

  it('prefers a binder copy over a newer collection-deck copy', () => {
    const old = print('old', '2010-01-01')
    const recent = print('recent', '2026-01-01')
    const result = selectPreferredDeckPrinting({
      printings: [recent, old],
      ownedCandidates: [owned(recent, { deckQty: 4 }), owned(old, { binderQty: 1 })],
    })
    expect(result).toMatchObject({ sfCard: old, source: 'owned-binder', cardPrintId: 'cp-old' })
  })

  it('ranks newest first, then quantity, then non-foil', () => {
    const recent = print('recent', '2026-01-01')
    const old = print('old', '2010-01-01')
    const ranked = rankOwnedPrintingCandidates([
      owned(old, { binderQty: 20 }),
      owned(recent, { binderQty: 1, foil: true, id: 'foil' }),
      owned(recent, { binderQty: 2, foil: true, id: 'foil-two' }),
      owned(recent, { binderQty: 2, foil: false, id: 'normal-two' }),
    ], [old, recent])
    expect(ranked.map(entry => entry.candidate.id)).toEqual(['normal-two', 'foil-two', 'foil', 'owned-old'])
  })

  it('preserves an exact owned foreign foil printing', () => {
    const foreign = print('foreign', '2025-01-01', { lang: 'jpn' })
    const result = selectPreferredDeckPrinting({
      printings: [foreign],
      ownedCandidates: [owned(foreign, { binderQty: 1, foil: true })],
    })
    expect(result).toMatchObject({ sfCard: foreign, foil: true, source: 'owned-binder' })
  })

  it('uses the newest English printing for an unowned card', () => {
    const foreign = print('foreign-new', '2026-01-01', { lang: 'zhs' })
    const english = print('english-old', '2024-01-01')
    expect(selectPreferredDeckPrinting({ printings: [foreign, english] }).sfCard).toBe(english)
  })

  it('uses the fallback when no English catalog printing is usable', () => {
    const foreign = print('foreign', '2026-01-01', { lang: 'zhs' })
    const fallback = print('fallback', '2024-01-01', { lang: 'en' })
    expect(selectPreferredDeckPrinting({ printings: [foreign], fallbackCard: fallback }).sfCard).toBe(fallback)
  })

  it('defaults to foil only for a foil-only printing', () => {
    const foilOnly = print('foil-only', '2026-01-01', { finishes: ['foil'] })
    expect(selectPreferredDeckPrinting({ printings: [foilOnly] }).foil).toBe(true)
  })
})
