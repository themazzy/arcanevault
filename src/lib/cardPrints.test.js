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
  // Henrika: only foreign + unknown-lang printings exist in card_prints and the
  // oracle sync hasn't reached her — the Spanish row comes back FIRST, but an
  // English/unknown printing must still win the pick.
  { id: 'p4', oracle_id: 'o4', scryfall_id: 's4-es', name: 'Henrika Domnathi // Henrika, Infernal Seer', lang: 'es', image_uri: 'henrika-es.jpg' },
  { id: 'p4b', oracle_id: 'o4', scryfall_id: 's4-en', name: 'Henrika Domnathi // Henrika, Infernal Seer', lang: 'en', image_uri: 'henrika-en.jpg' },
  // Only-foreign-and-unknown card: unknown lang should beat explicit foreign.
  { id: 'p5', oracle_id: 'o5', scryfall_id: 's5-de', name: 'Beispiel', lang: 'de', image_uri: 'beispiel-de.jpg' },
  { id: 'p5b', oracle_id: 'o5', scryfall_id: 's5-x', name: 'Beispiel', lang: null, image_uri: 'beispiel-unknown.jpg' },
]

// oracle_cards: English-only oracle bulk, one row per oracle_id. o1/o2 are
// covered; o3/o4/o5 deliberately are NOT (sync hasn't reached them) so those
// resolve via the card_prints fallback.
const ORACLE_ROWS = [
  { oracle_id: 'o1', scryfall_id: 's1-oc', name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', image_uri: 'sol-en.jpg' },
  { oracle_id: 'o2', scryfall_id: 's2-oc', name: 'Cultivate', type_line: 'Sorcery', oracle_text: 'Search your library…', image_uri: 'cultivate-en.jpg' },
]

function makeQuery(rows) {
  let cols = []
  const filters = []
  const run = () => rows
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
  sb.from.mockImplementation(table => makeQuery(table === 'oracle_cards' ? ORACLE_ROWS : DB_ROWS))
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

  it('prefers the oracle_cards English record over card_prints printings', async () => {
    const map = await fetchCardPrintsByOracleIds(['o2'])
    expect(map.size).toBe(1)
    expect(map.get('o2').scryfall_id).toBe('s2-oc') // oracle_cards row, not p2/p2b
    expect(map.get('o2').lang).toBe('en')
  })

  it('falls back to card_prints preferring English over a foreign printing seen first', async () => {
    // o4 is not in oracle_cards; the Spanish row is returned before the English
    // one. The English printing's art must win the recommendation tile.
    const map = await fetchCardPrintsByOracleIds(['o4'])
    expect(map.size).toBe(1)
    expect(map.get('o4').scryfall_id).toBe('s4-en')
    expect(map.get('o4').image_uri).toBe('henrika-en.jpg')
  })

  it('prefers unknown-lang (legacy, mostly English) over an explicit foreign printing', async () => {
    const map = await fetchCardPrintsByOracleIds(['o5'])
    expect(map.get('o5').scryfall_id).toBe('s5-x')
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
