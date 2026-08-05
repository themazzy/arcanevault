import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MATCH_NOTE, parseImportText, resolveImportEntries } from './importFlow'

vi.mock('./scryfall', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchScryfallBatch: vi.fn(), fetchScryfallNamed: vi.fn() }
})
import { fetchScryfallBatch, fetchScryfallNamed } from './scryfall'

describe('parseImportText — CSV vs text heuristic', () => {
  it('routes a real Manabox CSV header to the CSV parser', () => {
    const csv = 'name,set code,quantity\nLightning Bolt,m10,4'
    const result = parseImportText(csv)
    expect(result.source).toBe('csv')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe('Lightning Bolt')
  })

  it('preserves same-named ManaBox deck and wishlist as separate source locations', () => {
    const csv = [
      'name,set code,quantity,binder name,binder type',
      'Arachnogenesis,dsc,1,Tadeas,list',
      'Arcades the Strategist,m19,1,Tadeas,deck',
    ].join('\n')

    const result = parseImportText(csv)

    expect(Object.keys(result.folders).sort()).toEqual(['deck|Tadeas', 'list|Tadeas'])
    expect(result.entries.map(entry => entry.sourceLocation)).toEqual(['list|Tadeas', 'deck|Tadeas'])
  })

  it('does NOT route a decklist line that happens to contain "name" + comma (regression)', () => {
    // First line starts with a qty token → must be treated as a decklist,
    // even though it contains a comma and the word "name".
    const text = '4 Name of the Snake, the Wanderer\n2 Lightning Bolt'
    const result = parseImportText(text)
    expect(result.source).toBe('text')
    expect(result.entries[0].name).toBe('Name of the Snake, the Wanderer')
  })

  it('does NOT route "1x Foo" qty syntax to CSV either', () => {
    const text = '1x Foo, the Bar (m10) 1'
    const result = parseImportText(text)
    expect(result.source).toBe('text')
  })

  it('parses a plain decklist as text', () => {
    const text = '4 Lightning Bolt\n3 Counterspell'
    const result = parseImportText(text)
    expect(result.source).toBe('text')
    expect(result.entries.map(e => e.qty)).toEqual([4, 3])
  })
})

describe('resolveImportEntries — per-batch error tolerance', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.resetAllMocks()
    fetchScryfallNamed.mockResolvedValue(null)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('continues past a thrown batch and still matches surviving cards', async () => {
    // Build 80 entries → 2 batches (75 + 5). First batch throws, second succeeds.
    const entries = Array.from({ length: 80 }, (_, i) => ({
      name: `Card ${i}`, qty: 1,
    }))

    fetchScryfallBatch
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        data: [
          { id: 'x', name: 'Card 75', set: 'm10', collector_number: '1' },
        ],
      })

    const rows = await resolveImportEntries(entries)
    // Cards in the failed first batch are unmatched but present
    expect(rows).toHaveLength(80)
    const matched = rows.filter(r => r.status === 'matched')
    expect(matched).toHaveLength(1)
    expect(matched[0].resolvedName).toBe('Card 75')
    // Failed-batch rows carry the batch-error reason
    const failed = rows.filter(r => r.status === 'missing')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[0].reason).toBe('Scryfall lookup failed')
  })

  it('uses the "No Scryfall match" reason when all batches succeed but a card is absent', async () => {
    fetchScryfallBatch.mockResolvedValueOnce({ data: [] })
    const rows = await resolveImportEntries([{ name: 'Nonexistent Card', qty: 1 }])
    expect(rows[0].status).toBe('missing')
    expect(rows[0].reason).toBe('No Scryfall match')
  })
})

describe('resolveImportEntries — fuzzy fallback for names /cards/collection misses', () => {
  const HULLBREAKER = {
    id: 'c9f1',
    name: 'Hullbreaker Horror',
    flavor_name: 'Prime Mirelurk Queen',
    set: 'pip',
    collector_number: '344',
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.resetAllMocks()
    fetchScryfallNamed.mockResolvedValue(null)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('resolves a flavor name and flags it as such', async () => {
    // The collection endpoint knows printed names only, so a Universes Beyond
    // flavor name comes back empty and only the fuzzy lookup can place it.
    fetchScryfallBatch.mockResolvedValueOnce({ data: [] })
    fetchScryfallNamed.mockResolvedValueOnce(HULLBREAKER)

    const rows = await resolveImportEntries([{ name: 'Prime Mirelurk Queen', qty: 1 }])

    expect(fetchScryfallNamed).toHaveBeenCalledWith('Prime Mirelurk Queen')
    expect(rows[0].status).toBe('matched')
    expect(rows[0].sfCard).toBe(HULLBREAKER)
    expect(rows[0].resolvedName).toBe('Hullbreaker Horror')
    expect(rows[0].resolvedSetCode).toBe('pip')
    expect(rows[0].resolvedCollectorNumber).toBe('344')
    expect(rows[0].matchNote).toBe(MATCH_NOTE.FLAVOR_NAME)
    // The typed name is kept so the preview can show "typed → resolved".
    expect(rows[0].name).toBe('Prime Mirelurk Queen')
  })

  it('reads a flavor name off a double-faced card face', async () => {
    fetchScryfallBatch.mockResolvedValueOnce({ data: [] })
    fetchScryfallNamed.mockResolvedValueOnce({
      id: 'dfc',
      name: 'Front // Back',
      card_faces: [{ flavor_name: 'Alt Front' }, { flavor_name: 'Alt Back' }],
    })

    const rows = await resolveImportEntries([{ name: 'Alt Back', qty: 1 }])
    expect(rows[0].matchNote).toBe(MATCH_NOTE.FLAVOR_NAME)
  })

  it('flags a typo-corrected name as approximate rather than a flavor name', async () => {
    fetchScryfallBatch.mockResolvedValueOnce({ data: [] })
    fetchScryfallNamed.mockResolvedValueOnce({ id: 'sol', name: 'Sol Ring', set: 'lea', collector_number: '270' })

    const rows = await resolveImportEntries([{ name: 'Sol Rin', qty: 1 }])
    expect(rows[0].status).toBe('matched')
    expect(rows[0].matchNote).toBe(MATCH_NOTE.APPROXIMATE)
  })

  it('leaves matchNote null when the fuzzy hit is just the typed name punctuated differently', async () => {
    fetchScryfallBatch.mockResolvedValueOnce({ data: [] })
    fetchScryfallNamed.mockResolvedValueOnce({ id: 'j', name: "Jace, Vryn's Prodigy", set: 'ori', collector_number: '60' })

    const rows = await resolveImportEntries([{ name: 'Jace Vryns Prodigy', qty: 1 }])
    expect(rows[0].status).toBe('matched')
    expect(rows[0].matchNote).toBeNull()
  })

  it('does not run a fuzzy lookup for names the batch already matched', async () => {
    fetchScryfallBatch.mockResolvedValueOnce({
      data: [{ id: 'b', name: 'Lightning Bolt', set: 'm10', collector_number: '146' }],
    })

    const rows = await resolveImportEntries([{ name: 'Lightning Bolt', qty: 4 }])
    expect(rows[0].matchNote).toBeNull()
    expect(fetchScryfallNamed).not.toHaveBeenCalled()
  })

  it('asks once per distinct unmatched name, not once per row', async () => {
    fetchScryfallBatch.mockResolvedValueOnce({ data: [] })
    fetchScryfallNamed.mockResolvedValue(HULLBREAKER)

    // Two rows, same name, different foilness → merged separately by makeImportKey.
    const rows = await resolveImportEntries([
      { name: 'Prime Mirelurk Queen', qty: 1 },
      { name: 'Prime Mirelurk Queen', qty: 1, foil: true },
    ])

    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.status === 'matched')).toBe(true)
    expect(fetchScryfallNamed).toHaveBeenCalledTimes(1)
  })

  it('caps the number of fuzzy lookups so a junk paste cannot fan out', async () => {
    fetchScryfallBatch.mockResolvedValue({ data: [] })
    const entries = Array.from({ length: 200 }, (_, i) => ({ name: `Junk ${i}`, qty: 1 }))

    const rows = await resolveImportEntries(entries)

    expect(fetchScryfallNamed).toHaveBeenCalledTimes(60)
    expect(rows.every(row => row.status === 'missing')).toBe(true)
  })

  it('still reports progress while the fuzzy pass runs', async () => {
    fetchScryfallBatch.mockResolvedValueOnce({ data: [] })
    const seen = []

    await resolveImportEntries(
      [{ name: 'Alpha', qty: 1 }, { name: 'Beta', qty: 1 }],
      (done, total) => seen.push([done, total]),
    )

    // 1 batch + 2 fuzzy lookups
    expect(seen).toEqual([[1, 1], [2, 3], [3, 3]])
  })
})
