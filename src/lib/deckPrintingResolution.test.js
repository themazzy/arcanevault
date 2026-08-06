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

  it('does not canonicalize onto an Art Series double-faced row', () => {
    // "Birgi, God of Storytelling // Birgi, God of Storytelling" (Kaldheim Art
    // Series) aliases to the same front face as the real card and sorts first
    // alphabetically, which is how the art card ended up on the tile.
    const artRow = {
      name: 'Birgi, God of Storytelling // Birgi, God of Storytelling',
      type_line: 'Card // Card',
    }
    const realRow = {
      name: 'Birgi, God of Storytelling // Harnfel, Horn of Bounty',
      type_line: 'Legendary Creature — God // Legendary Artifact',
    }
    expect(resolveCanonicalDeckCardName('Birgi, God of Storytelling', {
      printings: [artRow, realRow],
    })).toBe('Birgi, God of Storytelling // Harnfel, Horn of Bounty')
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

  it('takes the cheapest binder copy, not the newest', () => {
    const newest = print('newest', '2026-01-01', { prices: { eur: '4.00' } })
    const cheaper = print('cheaper', '2012-01-01', { prices: { eur: '1.25' } })
    const result = selectPreferredDeckPrinting({
      printings: [newest, cheaper],
      ownedCandidates: [owned(newest, { binderQty: 1 }), owned(cheaper, { binderQty: 1 })],
    })
    expect(result).toMatchObject({ sfCard: cheaper, source: 'owned-binder', cardPrintId: 'cp-cheaper' })
  })

  it('keeps binders ahead of collection decks even when the deck copy is cheaper', () => {
    const binderPrint = print('binder', '2020-01-01', { prices: { eur: '3.00' } })
    const deckPrint = print('deck', '2021-01-01', { prices: { eur: '0.40' } })
    const result = selectPreferredDeckPrinting({
      printings: [binderPrint, deckPrint],
      ownedCandidates: [owned(deckPrint, { deckQty: 1 }), owned(binderPrint, { binderQty: 1 })],
    })
    expect(result).toMatchObject({ sfCard: binderPrint, source: 'owned-binder' })
  })

  it('orders collection-deck copies by price too', () => {
    const dear = print('dear', '2026-01-01', { prices: { eur: '7.00' } })
    const cheap = print('cheap', '2018-01-01', { prices: { eur: '2.00' } })
    const result = selectPreferredDeckPrinting({
      printings: [dear, cheap],
      ownedCandidates: [owned(dear, { deckQty: 1 }), owned(cheap, { deckQty: 1 })],
    })
    expect(result).toMatchObject({ sfCard: cheap, source: 'owned-deck' })
  })

  it('prices an owned copy at its own finish rather than the cheapest finish', () => {
    // The foil copy is the one physically owned, so it is judged on eur_foil —
    // its printing's cheap non-foil price is not a copy the user has.
    const foilCopy = print('foil-copy', '2026-01-01', { prices: { eur: '0.50', eur_foil: '9.00' } })
    const plainCopy = print('plain-copy', '2015-01-01', { prices: { eur: '2.00', eur_foil: '30.00' } })
    const result = selectPreferredDeckPrinting({
      printings: [foilCopy, plainCopy],
      ownedCandidates: [
        owned(foilCopy, { binderQty: 1, foil: true }),
        owned(plainCopy, { binderQty: 1 }),
      ],
    })
    expect(result).toMatchObject({ sfCard: plainCopy, foil: false, source: 'owned-binder' })
  })

  it('sorts owned copies with no price behind priced ones', () => {
    const unpriced = print('unpriced', '2026-01-01')
    const priced = print('priced', '2010-01-01', { prices: { eur: '6.00' } })
    const result = selectPreferredDeckPrinting({
      printings: [unpriced, priced],
      ownedCandidates: [owned(unpriced, { binderQty: 1 }), owned(priced, { binderQty: 1 })],
    })
    expect(result).toMatchObject({ sfCard: priced, source: 'owned-binder' })
  })

  it('falls back to newest, quantity, then non-foil when no owned copy is priced', () => {
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

  it('uses the newest English printing for an unowned card with no prices', () => {
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

  // The bulk add resolves against `get_deck_builder_display_printings`, whose
  // projection carries neither `finishes` nor `prices`. Feeding those rows in
  // directly reads as "non-foil only, unpriced" for every card: a foil-only
  // printing resolves to non-foil, and the cheapest-priced search never runs at
  // all — so the caller has to hydrate real card_prints rows for the ids the RPC
  // picks. These pin why, since the failure is silent and plausible-looking.
  describe('printings must be real catalogue rows, not the display projection', () => {
    // Shape of displayPrintingRowToCard's output: id/set/lang/released_at and a
    // display_* price triple, but no finishes and no prices.
    const projection = (id, extra = {}) => ({
      id,
      name: 'Lightning Bolt',
      set: id,
      collector_number: '1',
      lang: 'en',
      released_at: '2026-01-01',
      display_price: 3.5,
      display_foil: true,
      ...extra,
    })

    it('mis-resolves a foil-only printing when finishes are missing', () => {
      expect(selectPreferredDeckPrinting({ printings: [projection('proj')] }).foil).toBe(false)
      // Same printing, hydrated: the finish the RPC actually chose survives.
      const hydrated = print('proj', '2026-01-01', { finishes: ['foil'] })
      expect(selectPreferredDeckPrinting({ printings: [hydrated] }).foil).toBe(true)
    })

    it('cannot compare prices without a prices object', () => {
      const dearHydrated = print('dear', '2026-02-01', { prices: { eur: '20.00' } })
      const cheapProjection = projection('cheap', { display_price: 1 })
      // The cheap one is invisible to the price search, so the dear hydrated row
      // wins on price and the run quietly buys the wrong copy.
      const result = selectPreferredDeckPrinting({
        printings: [dearHydrated, cheapProjection],
        priceSource: 'cardmarket_trend',
      })
      expect(result.sfCard).toBe(dearHydrated)
      expect(result.source).toBe('automatic-cheapest')
    })
  })

  describe('cheapest-priced automatic pick', () => {
    it('buys the cheapest priced printing rather than the newest', () => {
      const newest = print('newest', '2026-01-01', { prices: { eur: '2.40' } })
      const older = print('older', '2015-01-01', { prices: { eur: '1.10' } })
      const result = selectPreferredDeckPrinting({ printings: [newest, older] })
      expect(result).toMatchObject({ sfCard: older, foil: false, source: 'automatic-cheapest' })
    })

    it('takes a foil when it is the cheapest copy of the card', () => {
      const nonfoil = print('nonfoil', '2026-01-01', { prices: { eur: '2.40', eur_foil: '9.00' } })
      const cheapFoil = print('cheap-foil', '2020-01-01', { prices: { eur: '3.00', eur_foil: '0.95' } })
      const result = selectPreferredDeckPrinting({ printings: [nonfoil, cheapFoil] })
      expect(result).toMatchObject({ sfCard: cheapFoil, foil: true, source: 'automatic-cheapest' })
    })

    it('never picks a foil the printing does not come in', () => {
      const nonfoilOnly = print('nonfoil-only', '2026-01-01', {
        finishes: ['nonfoil'],
        // A stale foil price on a print with no foil finish must not be used.
        prices: { eur: '2.00', eur_foil: '0.10' },
      })
      expect(selectPreferredDeckPrinting({ printings: [nonfoilOnly] })).toMatchObject({
        sfCard: nonfoilOnly,
        foil: false,
      })
    })

    it('ignores a cheaper foreign printing when an English one is priced', () => {
      const english = print('english', '2024-01-01', { prices: { eur: '2.10' } })
      const japanese = print('japanese', '2026-01-01', { lang: 'ja', prices: { eur: '0.80' } })
      expect(selectPreferredDeckPrinting({ printings: [japanese, english] }).sfCard).toBe(english)
    })

    it('falls back to the cheapest foreign printing when the card has no English print', () => {
      const cheap = print('ja-cheap', '2020-01-01', { lang: 'ja', prices: { eur: '0.80' } })
      const dear = print('ja-dear', '2026-01-01', { lang: 'ja', prices: { eur: '5.00' } })
      expect(selectPreferredDeckPrinting({ printings: [dear, cheap] }).sfCard).toBe(cheap)
    })

    it('treats a null lang as English (the catalog query returns those for en)', () => {
      const nullLang = print('null-lang', '2024-01-01', { lang: null, prices: { eur: '3.00' } })
      const japanese = print('japanese', '2026-01-01', { lang: 'ja', prices: { eur: '0.10' } })
      expect(selectPreferredDeckPrinting({ printings: [japanese, nullLang] }).sfCard).toBe(nullLang)
    })

    it('prices in the selected source only, never mixing currencies', () => {
      const cheapEur = print('cheap-eur', '2024-01-01', { prices: { eur: '1.00', usd: '9.00' } })
      const cheapUsd = print('cheap-usd', '2023-01-01', { prices: { eur: '8.00', usd: '2.00' } })
      const printings = [cheapEur, cheapUsd]
      expect(selectPreferredDeckPrinting({ printings, priceSource: 'cardmarket_trend' }).sfCard).toBe(cheapEur)
      expect(selectPreferredDeckPrinting({ printings, priceSource: 'tcgplayer_market' }).sfCard).toBe(cheapUsd)
    })

    it('falls back to the newest English printing when nothing carries a price', () => {
      const newest = print('newest', '2026-01-01')
      const older = print('older', '2015-01-01')
      expect(selectPreferredDeckPrinting({ printings: [older, newest] })).toMatchObject({
        sfCard: newest,
        source: 'automatic',
      })
    })

    it('ignores printings priced at zero', () => {
      const zero = print('zero', '2026-01-01', { prices: { eur: '0' } })
      const priced = print('priced', '2015-01-01', { prices: { eur: '4.00' } })
      expect(selectPreferredDeckPrinting({ printings: [zero, priced] }).sfCard).toBe(priced)
    })

    it('keeps the newest printing when two share the cheapest price', () => {
      const newest = print('newest', '2026-01-01', { prices: { eur: '1.00' } })
      const older = print('older', '2015-01-01', { prices: { eur: '1.00' } })
      expect(selectPreferredDeckPrinting({ printings: [older, newest] }).sfCard).toBe(newest)
    })

    it('still prefers an owned copy over a cheaper unowned printing', () => {
      const ownedPrint = print('owned', '2010-01-01', { prices: { eur: '20.00' } })
      const cheap = print('cheap', '2026-01-01', { prices: { eur: '0.50' } })
      const result = selectPreferredDeckPrinting({
        printings: [cheap, ownedPrint],
        ownedCandidates: [owned(ownedPrint, { binderQty: 1 })],
      })
      expect(result).toMatchObject({ sfCard: ownedPrint, source: 'owned-binder' })
    })

    // The bulk auto-fill used to throw when an owned copy's print metadata
    // wouldn't hydrate, which aborted the entire batch. Degrading to the
    // cheapest catalog printing is what lets it skip just that card instead.
    it('degrades to the cheapest printing when no owned copy can be resolved', () => {
      const cheap = print('cheap', '2015-01-01', { prices: { eur: '1.00' } })
      const dear = print('dear', '2026-01-01', { prices: { eur: '6.00' } })
      const unhydratable = {
        id: 'owned-ghost',
        scryfall_id: 'not-in-catalog',
        card_print_id: 'cp-ghost',
        binderQty: 1,
        deckQty: 0,
        foil: false,
      }
      const result = selectPreferredDeckPrinting({
        printings: [dear, cheap],
        ownedCandidates: [unhydratable],
      })
      expect(result).toMatchObject({ sfCard: cheap, cardPrintId: null, source: 'automatic-cheapest' })
    })

    // Art Series prints live in card_prints beside real ones. They carry no
    // price, so before the cheapest-first rule they only surfaced as a stale
    // "newest printing"; either way a deck must never land on one.
    it('never auto-picks an art-series printing', () => {
      const artCard = print('art', '2026-01-01', { type_line: 'Card', prices: { eur: '0.10' } })
      const real = print('real', '2015-01-01', { type_line: 'Artifact', prices: { eur: '4.00' } })
      expect(selectPreferredDeckPrinting({ printings: [artCard, real] }).sfCard).toBe(real)
    })

    it('skips art-series printings in the unpriced fallback too', () => {
      const artCard = print('art', '2026-01-01', { type_line: 'Card // Card' })
      const real = print('real', '2015-01-01', { type_line: 'Legendary Creature — God' })
      expect(selectPreferredDeckPrinting({ printings: [artCard, real] }).sfCard).toBe(real)
    })

    it('skips tokens and emblems that share a real card name', () => {
      const token = print('token', '2026-01-01', { type_line: 'Token Creature — Angel', prices: { eur: '0.05' } })
      const emblem = print('emblem', '2026-01-01', { type_line: 'Emblem — Chandra', prices: { eur: '0.05' } })
      const real = print('real', '2015-01-01', { type_line: 'Creature — Angel', prices: { eur: '9.00' } })
      expect(selectPreferredDeckPrinting({ printings: [token, emblem, real] }).sfCard).toBe(real)
    })

    it('never auto-picks a digital-only printing', () => {
      // Crusade's newest English row is the Magic Online promo — unpriced, so
      // cheapest-first can't reach it, but the release-date fallback could.
      const mtgo = print('mtgo', '2026-01-01', { digital: true })
      const paper = print('paper', '2010-01-01')
      expect(selectPreferredDeckPrinting({ printings: [mtgo, paper] }).sfCard).toBe(paper)
    })

    it('resolves an Arena-exclusive card rather than refusing it', () => {
      // Nothing paper exists, so the only printing there is beats no answer.
      const arenaOnly = print('arena', '2024-01-01', { digital: true })
      expect(selectPreferredDeckPrinting({ printings: [arenaOnly] }).sfCard).toBe(arenaOnly)
    })

    it('keeps a printing whose type_line is unknown', () => {
      // ~158 catalogue rows have no type_line; unknown is not an art card.
      const untyped = print('untyped', '2015-01-01', { type_line: null, prices: { eur: '1.00' } })
      expect(selectPreferredDeckPrinting({ printings: [untyped] }).sfCard).toBe(untyped)
    })

    it('still resolves an owned art card rather than dropping the placement', () => {
      // A collector can genuinely own one — the exclusion is about what gets
      // auto-picked, not about erasing a copy they told us they have.
      const artCard = print('art', '2021-01-01', { type_line: 'Card // Card' })
      const real = print('real', '2015-01-01', { type_line: 'Artifact', prices: { eur: '4.00' } })
      const result = selectPreferredDeckPrinting({
        printings: [artCard, real],
        ownedCandidates: [owned(artCard, { binderQty: 1 })],
      })
      expect(result).toMatchObject({ sfCard: artCard, source: 'owned-binder', cardPrintId: 'cp-art' })
    })

    it('prefers the owned copy that did resolve over the cheapest printing', () => {
      const ownedPrint = print('owned', '2010-01-01', { prices: { eur: '20.00' } })
      const cheap = print('cheap', '2026-01-01', { prices: { eur: '0.50' } })
      const ghost = {
        id: 'owned-ghost',
        scryfall_id: 'not-in-catalog',
        card_print_id: 'cp-ghost',
        binderQty: 1,
        deckQty: 0,
        foil: false,
      }
      const result = selectPreferredDeckPrinting({
        printings: [cheap, ownedPrint],
        ownedCandidates: [ghost, owned(ownedPrint, { binderQty: 1 })],
      })
      expect(result).toMatchObject({ sfCard: ownedPrint, source: 'owned-binder' })
    })
  })
})
