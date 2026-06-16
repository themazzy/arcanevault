import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing the module under test. The mock mirrors real
// PostgREST behavior: a query only returns the columns named in .select(), so a
// row keyed by a column that wasn't selected comes back without that field.
vi.mock('./supabase', () => ({ sb: { from: vi.fn() } }))

const { sb } = await import('./supabase')
const { fetchCardPrintsByOracleIds } = await import('./cardPrints')

// Full rows as they exist in the DB. The mock projects each row down to only
// the requested columns, the same way PostgREST does.
const DB_ROWS = [
  { id: 'p1', oracle_id: 'o1', scryfall_id: 's1', name: 'Sol Ring', type_line: 'Artifact' },
  { id: 'p2', oracle_id: 'o2', scryfall_id: 's2', name: 'Cultivate', type_line: 'Sorcery' },
  // Two printings share an oracle_id — only the first should be kept.
  { id: 'p2b', oracle_id: 'o2', scryfall_id: 's2b', name: 'Cultivate', type_line: 'Sorcery' },
]

function makeQuery() {
  let cols = []
  const q = {
    select(c) { cols = c.split(','); return q },
    in(col, batch) {
      const rows = DB_ROWS
        .filter(r => batch.includes(r[col]))
        // Project to exactly the selected columns — fields outside .select() are
        // absent, just like a real PostgREST response.
        .map(r => Object.fromEntries(cols.filter(k => k in r).map(k => [k, r[k]])))
      return Promise.resolve({ data: rows, error: null })
    },
  }
  return q
}

beforeEach(() => {
  vi.clearAllMocks()
  sb.from.mockImplementation(() => makeQuery())
})

describe('fetchCardPrintsByOracleIds', () => {
  it('returns an empty map for empty/absent input without querying', async () => {
    expect((await fetchCardPrintsByOracleIds([])).size).toBe(0)
    expect((await fetchCardPrintsByOracleIds(null)).size).toBe(0)
    expect(sb.from).not.toHaveBeenCalled()
  })

  it('keys resolved rows by oracle_id (regression: oracle_id must be selected)', async () => {
    // Before the fix CARD_PRINT_SELECT_COLUMNS omitted oracle_id, so .in() matched
    // rows server-side but the returned rows had no oracle_id field and the keying
    // loop dropped every one — leaving the recommander pipeline with 0 picks.
    const map = await fetchCardPrintsByOracleIds(['o1', 'o2'])
    expect(map.size).toBe(2)
    expect(map.get('o1').name).toBe('Sol Ring')
    expect(map.get('o2').name).toBe('Cultivate')
  })

  it('keeps the first printing when several share an oracle_id', async () => {
    const map = await fetchCardPrintsByOracleIds(['o2'])
    expect(map.size).toBe(1)
    expect(map.get('o2').scryfall_id).toBe('s2') // first seen, not s2b
  })

  it('de-dupes the requested ids', async () => {
    const map = await fetchCardPrintsByOracleIds(['o1', 'o1', 'o1'])
    expect(map.size).toBe(1)
    expect(map.get('o1')).toBeTruthy()
  })
})
