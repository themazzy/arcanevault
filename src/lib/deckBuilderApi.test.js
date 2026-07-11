import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the scryfall module BEFORE importing deckBuilderApi so the `const sfFetch = sfGet`
// closure binds to our mock instead of the real rate-limited fetch.
vi.mock('./scryfall', () => ({
  sfGet: vi.fn(),
  sfUrl: (u) => u,
  // getCardImageUri now delegates here; mirror the real lookup so meta tests pass.
  getImageUri: (c, size = 'normal') =>
    c?.image_uris?.[size] ?? c?.card_faces?.[0]?.image_uris?.[size] ?? null,
}))

vi.mock('./supabase', () => ({ sb: { from: vi.fn(), rpc: vi.fn() } }))

import {
  parseTextDecklist, parseImportUrl, searchCards, fetchPaperPrintings,
  getDeckBuilderCardMeta, importProxyUrl, fetchPaperPrintingsByNamesFromDb,
  fetchRecommendationMetadataByNames, recommendationMetadataRowToCard,
  pickAutomaticDeckPrinting, FORMATS, nameToSlug, getEdhrecPartnerSlugCandidates,
} from './deckBuilderApi'
import { EDH_FORMAT_IDS } from './commanderBracket'
import { sfGet } from './scryfall'
import { sb } from './supabase'

describe('importProxyUrl', () => {
  it('builds worker proxy URLs on the prod origin', () => {
    expect(importProxyUrl('archidekt', '123456')).toBe('https://deckloom.app/api/import/archidekt/123456')
    expect(importProxyUrl('moxfield', 'aBc_-9')).toBe('https://deckloom.app/api/import/moxfield/aBc_-9')
    expect(importProxyUrl('goldfish', '987')).toBe('https://deckloom.app/api/import/goldfish/987')
  })
  it('escapes ids so they cannot extend the path', () => {
    expect(importProxyUrl('moxfield', 'a/b')).toBe('https://deckloom.app/api/import/moxfield/a%2Fb')
  })
})

describe('nameToSlug (EDHREC commander slugs)', () => {
  // Regression: hyphens were stripped with the rest of the punctuation, so
  // "Nine-Fingers Keene" became ninefingers-keene and every EDHREC page 403'd.
  it('keeps a printed hyphen as a word break', () => {
    expect(nameToSlug('Nine-Fingers Keene')).toBe('nine-fingers-keene')
    expect(nameToSlug("Will-o'-the-Wisp")).toBe('will-o-the-wisp')
  })

  it('drops apostrophes and commas without splitting the word', () => {
    expect(nameToSlug("Atraxa, Praetors' Voice")).toBe('atraxa-praetors-voice')
    expect(nameToSlug('Krenko, Mob Boss')).toBe('krenko-mob-boss')
  })

  it('transliterates diacritics instead of deleting the letter', () => {
    expect(nameToSlug('Jötun Grunt')).toBe('jotun-grunt')
  })
})

describe('getEdhrecPartnerSlugCandidates', () => {
  it('combines both commander slugs, alphabetical order first', () => {
    const out = getEdhrecPartnerSlugCandidates('Tymna the Weaver', 'Thrasios, Triton Hero')
    // canonical (sorted) form is the first candidate for the pair
    expect(out[0]).toBe('thrasios-triton-hero-tymna-the-weaver')
    // both orders present as fallbacks (EDHREC serves either)
    expect(out).toContain('tymna-the-weaver-thrasios-triton-hero')
  })

  it('handles a Background pairing the same way', () => {
    const out = getEdhrecPartnerSlugCandidates('Wilson, Refined Grizzly', 'Agent of the Iron Throne')
    expect(out).toContain('agent-of-the-iron-throne-wilson-refined-grizzly')
  })

  it('dedupes', () => {
    const out = getEdhrecPartnerSlugCandidates('Krenko, Mob Boss', 'Krenko, Mob Boss')
    expect(out).toEqual([...new Set(out)])
  })
})

describe('FORMATS', () => {
  // commanderBracket keeps its own EDH-format-id set (to stay out of this
  // module's supabase/scryfall dependency graph) — catch any drift here.
  it('isEDH flags stay in sync with commanderBracket EDH_FORMAT_IDS', () => {
    const edhIds = FORMATS.filter(f => f.isEDH).map(f => f.id).sort()
    expect(edhIds).toEqual([...EDH_FORMAT_IDS].sort())
  })
})

describe('getDeckBuilderCardMeta', () => {
  // Every deck add path — normal search, recs, import, AND the commander
  // picker — builds its deck_cards row from this helper. The commander picker
  // used to hand-roll its row with the 'art_crop' image, which rendered the
  // commander as an art card in the deck list.
  it('uses the normal-size card image, never art_crop', () => {
    const meta = getDeckBuilderCardMeta({
      id: 'sf-1', set: 'who', collector_number: '42', type_line: 'Legendary Creature',
      mana_cost: '{2}{G}{U}', cmc: 4, color_identity: ['G', 'U'],
      image_uris: { normal: 'https://img/normal.jpg', art_crop: 'https://img/art.jpg' },
    })
    expect(meta.image_uri).toBe('https://img/normal.jpg')
  })

  it('falls back to the first face for image and text fields on multi-face cards', () => {
    const meta = getDeckBuilderCardMeta({
      id: 'sf-2', set: 'mid', collector_number: '7', cmc: 2, color_identity: ['W'],
      card_faces: [
        { type_line: 'Legendary Creature — Human', mana_cost: '{1}{W}', image_uris: { normal: 'https://img/front.jpg', art_crop: 'https://img/front-art.jpg' } },
        { type_line: 'Legendary Creature — Spirit', mana_cost: '', image_uris: { normal: 'https://img/back.jpg' } },
      ],
    })
    expect(meta.image_uri).toBe('https://img/front.jpg')
    expect(meta.type_line).toBe('Legendary Creature — Human')
    expect(meta.mana_cost).toBe('{1}{W}')
  })
})

describe('recommendation metadata', () => {
  beforeEach(() => { sb.rpc.mockReset() })

  it('maps an RPC row into the existing Scryfall-like card shape', () => {
    expect(recommendationMetadataRowToCard({
      requested_name: 'Ashling, Rekindled',
      scryfall_id: 'print-1', oracle_id: 'oracle-1', name: 'Sol Ring', lang: 'en',
      set_code: 'cmm', collector_number: '396', type_line: 'Artifact',
      mana_cost: '{1}', cmc: 1, color_identity: [], image_uri: 'https://img/normal.jpg',
      art_crop_uri: 'https://img/art.jpg', oracle_text: '{T}: Add {C}{C}.',
      legalities: { commander: 'legal' }, keywords: [], colors: [], produced_mana: ['C'],
    })).toMatchObject({
      requested_name: 'Ashling, Rekindled', id: 'print-1', oracle_id: 'oracle-1', name: 'Sol Ring', set: 'cmm', lang: 'en',
      collector_number: '396', legalities: { commander: 'legal' },
      image_uris: {
        small: 'https://img/normal.jpg', normal: 'https://img/normal.jpg',
        large: 'https://img/normal.jpg', art_crop: 'https://img/art.jpg',
      },
    })
  })

  it('deduplicates names and resolves them through the bounded Supabase RPC', async () => {
    sb.rpc.mockResolvedValue({
      data: [{ scryfall_id: 'print-1', oracle_id: 'oracle-1', name: 'Sol Ring', set_code: 'cmm', legalities: {} }],
      error: null,
    })

    const cards = await fetchRecommendationMetadataByNames(['Sol Ring', 'Sol Ring', ''])

    expect(sb.rpc).toHaveBeenCalledWith('get_recommendation_card_metadata', {
      requested_names: ['Sol Ring'],
    })
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe('print-1')
  })

  it('batches every recommendation instead of truncating cards below the fold', async () => {
    const names = Array.from({ length: 305 }, (_, index) => `Card ${index}`)
    sb.rpc.mockImplementation(async (_fn, { requested_names }) => ({
      data: requested_names.map((name, index) => ({
        scryfall_id: `${name}-${index}`,
        oracle_id: `oracle-${name}`,
        name,
        set_code: 'tst',
        legalities: { commander: 'legal' },
      })),
      error: null,
    }))

    const cards = await fetchRecommendationMetadataByNames(names)

    expect(sb.rpc).toHaveBeenCalledTimes(2)
    expect(sb.rpc.mock.calls[0][1].requested_names).toHaveLength(300)
    expect(sb.rpc.mock.calls[1][1].requested_names).toHaveLength(5)
    expect(cards).toHaveLength(305)
    expect(cards.at(-1).name).toBe('Card 304')
  })

  it('surfaces RPC failures to callers so they can degrade explicitly', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: new Error('rpc unavailable') })
    await expect(fetchRecommendationMetadataByNames(['Sol Ring'])).rejects.toThrow('rpc unavailable')
  })
})

describe('pickAutomaticDeckPrinting', () => {
  it('prefers an English printing over a newer foreign printing', () => {
    const zh = { id: 'zh-new', lang: 'zhs' }
    const en = { id: 'en-old', lang: 'en' }
    expect(pickAutomaticDeckPrinting([zh, en])).toBe(en)
  })

  it('uses an English recommendation fallback before unknown catalog rows', () => {
    const unknown = { id: 'legacy', lang: null }
    const fallback = { id: 'oracle-en', lang: 'en' }
    expect(pickAutomaticDeckPrinting([unknown], fallback)).toBe(fallback)
  })

  it('keeps the previous fallback when no English identity is known', () => {
    const first = { id: 'legacy', lang: null }
    expect(pickAutomaticDeckPrinting([first])).toBe(first)
  })
})

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

describe('searchCards — empty-query bail', () => {
  beforeEach(() => { sfGet.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  it('does NOT hit Scryfall when query and all filters are empty', async () => {
    const result = await searchCards({})
    expect(result).toEqual({ cards: [], hasMore: false })
    expect(sfGet).not.toHaveBeenCalled()
  })

  it('does NOT hit Scryfall when query is only whitespace', async () => {
    const result = await searchCards({ query: '   ' })
    expect(result).toEqual({ cards: [], hasMore: false })
    expect(sfGet).not.toHaveBeenCalled()
  })

  it('hits Scryfall when a colorIdentity filter is set even without a query', async () => {
    sfGet.mockResolvedValueOnce({ data: [{ id: 'x', name: 'A' }], has_more: false })
    const result = await searchCards({ colorIdentity: ['W', 'U'] })
    expect(sfGet).toHaveBeenCalledOnce()
    expect(result.cards).toHaveLength(1)
  })

  it('hits Scryfall when a cardType filter is set', async () => {
    sfGet.mockResolvedValueOnce({ data: [], has_more: false })
    await searchCards({ cardType: 'creature' })
    expect(sfGet).toHaveBeenCalledOnce()
    const url = sfGet.mock.calls[0][0]
    expect(url).toContain('t%3Acreature')
  })

  it('hits Scryfall when only a query is provided', async () => {
    sfGet.mockResolvedValueOnce({ data: [{ id: 'y', name: 'Lightning Bolt' }], has_more: false })
    const result = await searchCards({ query: 'lightning bolt' })
    expect(sfGet).toHaveBeenCalledOnce()
    expect(result.cards[0].name).toBe('Lightning Bolt')
  })

  it('anchors the query to the name field so oracle-text mentions are excluded', async () => {
    sfGet.mockResolvedValueOnce({ data: [], has_more: false })
    await searchCards({ query: 'void' })
    const url = sfGet.mock.calls[0][0]
    expect(url).toContain(encodeURIComponent('name:"void"'))
  })

  it('floats an exact name match to the top even under edhrec popularity order', async () => {
    // "Void" itself is a real but obscure card; EDHREC order would otherwise
    // rank it beneath more popular cards whose name merely contains "void".
    sfGet.mockResolvedValueOnce({
      data: [
        { id: 'popular-1', name: 'Void Winnower' },
        { id: 'popular-2', name: 'Encroaching Void' },
        { id: 'exact', name: 'Void' },
      ],
      has_more: false,
    })
    const result = await searchCards({ query: 'void', format: 'commander' })
    expect(result.cards[0].name).toBe('Void')
  })

  it('ranks a name-prefix match above other partial matches, exact match first', async () => {
    sfGet.mockResolvedValueOnce({
      data: [
        { id: 'a', name: 'Waking Nightmare' },
        { id: 'b', name: 'Nightmare Shepherd' },
        { id: 'c', name: 'Nightmare' },
      ],
      has_more: false,
    })
    const result = await searchCards({ query: 'nightmare' })
    expect(result.cards.map(c => c.name)).toEqual(['Nightmare', 'Nightmare Shepherd', 'Waking Nightmare'])
  })
})

describe('fetchPaperPrintings — face-name collision', () => {
  beforeEach(() => { sfGet.mockReset() })
  afterEach(() => { vi.restoreAllMocks() })

  // Scryfall's `!"name"` matches face names too, so an MDFC like
  // "Naktamun Lorespinner // Wheel of Fortune" leaks into results when
  // requesting printings of plain "Wheel of Fortune". Without the name filter,
  // resolvePreferredDeckPrinting would pick the Naktamun printing and the
  // wrong card would be added to the deck.
  it('filters out cards whose primary name does not match exactly', async () => {
    sfGet.mockResolvedValueOnce({
      data: [
        { id: 'naktamun', name: 'Naktamun Lorespinner // Wheel of Fortune' },
        { id: 'wof-1', name: 'Wheel of Fortune', set: 'lea' },
        { id: 'wof-2', name: 'Wheel of Fortune', set: '3ed' },
      ],
    })
    const printings = await fetchPaperPrintings('Wheel of Fortune')
    expect(printings.map(p => p.id)).toEqual(['wof-1', 'wof-2'])
  })

  it('keeps multi-face cards when the full name is requested', async () => {
    sfGet.mockResolvedValueOnce({
      data: [{ id: 'fi-1', name: 'Fire // Ice' }],
    })
    const printings = await fetchPaperPrintings('Fire // Ice')
    expect(printings).toHaveLength(1)
  })
})

describe('fetchPaperPrintingsByNamesFromDb', () => {
  beforeEach(() => {
    sb.from.mockReset()
    // /sets release-date lookup
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [
        { code: 'lea', released_at: '1993-08-05' },
        { code: 'm10', released_at: '2009-07-17' },
      ] }),
    })
  })
  afterEach(() => { vi.restoreAllMocks() })

  // Chainable query-builder stub: `.select().in()` resolves to { data }.
  const stub = data => ({ select: () => ({ in: () => Promise.resolve({ data }) }) })

  it('shapes prints, attaches newest-snapshot prices, sorts newest-first', async () => {
    sb.from.mockImplementation(table => {
      if (table === 'card_prints') return stub([
        { scryfall_id: 'p-old', name: 'Lightning Bolt', set_code: 'lea', collector_number: '161', type_line: 'Instant', mana_cost: '{R}', cmc: 1, color_identity: ['R'], image_uri: 'old.jpg' },
        { scryfall_id: 'p-new', name: 'Lightning Bolt', set_code: 'm10', collector_number: '146', type_line: 'Instant', mana_cost: '{R}', cmc: 1, color_identity: ['R'], image_uri: 'new.jpg' },
      ])
      if (table === 'card_prices') return stub([
        { scryfall_id: 'p-old', snapshot_date: '2026-06-13', price_regular_eur: 99, price_foil_eur: null, price_regular_usd: 120, price_foil_usd: null },
        { scryfall_id: 'p-old', snapshot_date: '2026-06-14', price_regular_eur: 80, price_foil_eur: null, price_regular_usd: 100, price_foil_usd: null },
        { scryfall_id: 'p-new', snapshot_date: '2026-06-14', price_regular_eur: 2, price_foil_eur: 5, price_regular_usd: 3, price_foil_usd: 6 },
      ])
      return stub([])
    })

    const map = await fetchPaperPrintingsByNamesFromDb(['Lightning Bolt'])
    const prints = map.get('Lightning Bolt')
    expect(prints.map(p => p.id)).toEqual(['p-new', 'p-old'])   // newest set first
    expect(prints[0]).toMatchObject({ set: 'm10', released_at: '2009-07-17' })
    expect(prints[0].prices).toEqual({ eur: '2', eur_foil: '5', usd: '3', usd_foil: '6' })
    // newest snapshot (06-14: 80) wins over older (06-13: 99)
    expect(prints[1].prices.eur).toBe('80')
  })

  it('returns an empty array for names with no catalog rows', async () => {
    sb.from.mockImplementation(() => stub([]))
    const map = await fetchPaperPrintingsByNamesFromDb(['Nonexistent Card'])
    expect(map.get('Nonexistent Card')).toEqual([])
  })
})
