import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseImportText, resolveImportEntries } from './importFlow'

vi.mock('./scryfall', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, fetchScryfallBatch: vi.fn() }
})
import { fetchScryfallBatch } from './scryfall'

describe('parseImportText — CSV vs text heuristic', () => {
  it('routes a real Manabox CSV header to the CSV parser', () => {
    const csv = 'name,set code,quantity\nLightning Bolt,m10,4'
    const result = parseImportText(csv)
    expect(result.source).toBe('csv')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].name).toBe('Lightning Bolt')
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
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
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
