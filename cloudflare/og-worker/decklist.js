// Pure helpers for the raw decklist endpoint
// (deckloom.app/api/decklist/<deck-id>.txt) — kept separate from worker.js so
// they can be unit-tested by vitest (see src/lib/decklistWorker.test.js)
// without a Workers runtime.
//
// The endpoint exists for third-party integrations (e.g. Tabletop Simulator
// deck importers) that cannot execute the SPA's JavaScript and therefore
// cannot read anything from the /d/<id> page itself. Output is plain MTG
// decklist lines (`1 Sol Ring`), with `// Attractions`, `// Sideboard`, and `// Commander`
// section markers.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Extract + validate the deck id from /api/decklist/<id> or
// /api/decklist/<id>.txt. Returns null unless the id is a well-formed UUID —
// the id goes straight into an RPC call, so nothing else may pass.
export function extractDecklistDeckId(url) {
  const m = new URL(url).pathname.match(/^\/api\/decklist\/([^/]+?)(?:\.txt)?$/)
  const id = m ? decodeURIComponent(m[1]) : null
  return id && UUID_RE.test(id) ? id : null
}

// Merge only identical printings/finishes and emit sorted MTG Arena-style
// lines. The Tabletop Simulator importer accepts `(SET) collector-number` for
// exact print selection, while Archidekt's `*F*` suffix carries foil status.
// Rows without printing metadata retain the old `<qty> <name>` fallback.
function mergedLines(rows) {
  const cards = new Map()
  for (const r of rows) {
    const name = typeof r?.name === 'string' ? r.name.trim() : ''
    if (!name) continue
    const setCode = typeof r?.set_code === 'string' ? r.set_code.trim() : ''
    const collectorNumber = typeof r?.collector_number === 'string' ? r.collector_number.trim() : ''
    const foil = r?.foil === true
    const key = JSON.stringify([name, setCode, collectorNumber, foil])
    const existing = cards.get(key)
    if (existing) {
      existing.qty += Math.max(1, Number(r.qty) || 1)
    } else {
      cards.set(key, {
        name,
        setCode,
        collectorNumber,
        foil,
        qty: Math.max(1, Number(r.qty) || 1),
      })
    }
  }
  return [...cards.values()]
    .sort((a, b) =>
      a.name.localeCompare(b.name) ||
      a.setCode.localeCompare(b.setCode) ||
      a.collectorNumber.localeCompare(b.collectorNumber, undefined, { numeric: true }) ||
      Number(a.foil) - Number(b.foil)
    )
    .map(({ name, setCode, collectorNumber, foil, qty }) => {
      const printing = setCode
        ? ` (${setCode})${collectorNumber ? ` ${collectorNumber}` : ''}`
        : ''
      return `${qty} ${name}${printing}${foil ? ' *F*' : ''}`
    })
}

// Render RPC rows (get_deck_cards_for_view payload) as a plain-text decklist.
// Maybeboard cards are not part of the deck and are omitted.
export function renderDecklistText(rows) {
  const list = Array.isArray(rows) ? rows : []
  const commander = list.filter(r => r?.is_commander)
  const main = list.filter(r => !r?.is_commander && !['attraction', 'side', 'maybe'].includes(r?.board))
  const attractions = list.filter(r => !r?.is_commander && r?.board === 'attraction')
  const side = list.filter(r => !r?.is_commander && r?.board === 'side')

  const lines = mergedLines(main)
  const attractionLines = mergedLines(attractions)
  const sideLines = mergedLines(side)
  const commanderLines = mergedLines(commander)
  if (attractionLines.length) lines.push('', '// Attractions', ...attractionLines)
  if (sideLines.length) lines.push('', '// Sideboard', ...sideLines)
  if (commanderLines.length) lines.push('', '// Commander', ...commanderLines)
  return lines.join('\n').trim() + '\n'
}
