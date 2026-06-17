import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase before importing the module under test. The mock mirrors real
// PostgREST behavior: a query only returns the columns named in .select(), so a
// row keyed by a column that wasn't selected comes back without that field. The
// builder is chainable + awaitable (.select().in().not() then await).
vi.mock('./supabase', () => ({ sb: { from: vi.fn() } }))

const { sb } = await import('./supabase')
const { fetchCardPrintsByOracleIds, fetchOracleTextByNames } = await import('./cardPrints')

// Full rows as they exist in the DB. The mock projects each row down to only
// the requested columns, the same way PostgREST does.
const DB_ROWS = [
  { id: 'p1', oracle_id: 'o1', scryfall_id: 's1', name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.' },
  { id: 'p2', oracle_id: 'o2', scryfall_id: 's2', name: 'Cultivate', type_line: 'Sorcery', oracle_text: 'Search your library…' },
  // Two printings share an oracle_id — only the first should be kept.
  { id: 'p2b', oracle_id: 'o2', scryfall_id: 's2b', name: 'Cultivate', type_line: 'Sorcery', oracle_text: 'Search your library…' },
  // Resonating Lute: the deck's printing row has NO oracle text and NO oracle_id
  // (an incomplete seed); a sibling printing carries the text.
  { id: 'p3', oracle_id: null, scryfall_id: 's3', name: 'Resonating Lute', type_line: 'Artifact', oracle_text: null },
  { id: 'p3b', oracle_id: 'o3', scryfall_id: 's3b', name: 'Resonating Lute', type_line: 'Artifact', oracle_text: 'Lands you control have "{T}: Add two mana…"' },
]

function makeQuery() {
  let cols = []
  const filters = []
  const run = () => DB_ROWS
    .filter(r => filters.every(f =>
      f.kind === 'in' ? f.batch.includes(r[f.col])
        : f.kind === 'notNull' ? r[f.col] != null
          : true))
    // Project to exactly the selected columns — fields outside .select() are
    // absent, just like a real PostgREST response.
    .map(r => Object.fromEntries(cols.filter(k => k in r).map(k => [k, r[k]])))
  const q = {
    select(c) { cols = c.split(','); return q },
    in(col, batch) { filters.push({ kind: 'in', col, batch }); return q },
    not(col, op, val) { if (op === 'is' && val === null) filters.push({ kind: 'notNull', col }); return q },
    then(resolve, reject) {
      try { resolve({ data: run(), error: null }) } catch (e) { reject(e) }
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

describe('fetchOracleTextByNames', () => {
  it('returns an empty map for empty/absent input without querying', async () => {
    expect((await fetchOracleTextByNames([])).size).toBe(0)
    expect((await fetchOracleTextByNames(null)).size).toBe(0)
    expect(sb.from).not.toHaveBeenCalled()
  })

  it('recovers oracle text from a sibling printing when the deck printing is blank', async () => {
    // Resonating Lute's blank printing has null oracle_text AND null oracle_id;
    // the helper must skip it and return the sibling that carries the text — so a
    // deck card whose exact printing is blank still classifies correctly instead
    // of falling to Synergy.
    const map = await fetchOracleTextByNames(['Resonating Lute'])
    expect(map.size).toBe(1)
    expect(map.get('Resonating Lute').scryfall_id).toBe('s3b')
    expect(map.get('Resonating Lute').oracle_text).toMatch(/Add two mana/)
  })

  it('resolves multiple names in one call', async () => {
    const map = await fetchOracleTextByNames(['Sol Ring', 'Resonating Lute'])
    expect([...map.keys()].sort()).toEqual(['Resonating Lute', 'Sol Ring'])
  })
})
