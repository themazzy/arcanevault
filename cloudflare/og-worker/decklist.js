// Pure helpers for the raw decklist endpoint
// (deckloom.app/api/decklist/<deck-id>.txt) — kept separate from worker.js so
// they can be unit-tested by vitest (see src/lib/decklistWorker.test.js)
// without a Workers runtime.
//
// The endpoint exists for third-party integrations (e.g. Tabletop Simulator
// deck importers) that cannot execute the SPA's JavaScript and therefore
// cannot read anything from the /d/<id> page itself. Output is plain MTG
// decklist lines (`1 Sol Ring`), with `// Sideboard` and `// Commander`
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

// Merge rows by card name (the plain-text format carries no printing info, so
// two printings of the same card collapse into one line) and emit sorted
// `<qty> <name>` lines.
function mergedLines(rows) {
  const byName = new Map()
  for (const r of rows) {
    const name = typeof r?.name === 'string' ? r.name.trim() : ''
    if (!name) continue
    byName.set(name, (byName.get(name) || 0) + Math.max(1, Number(r.qty) || 1))
  }
  return [...byName.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, qty]) => `${qty} ${name}`)
}

// Render RPC rows (get_deck_cards_for_view payload) as a plain-text decklist.
// Maybeboard cards are not part of the deck and are omitted.
export function renderDecklistText(rows) {
  const list = Array.isArray(rows) ? rows : []
  const commander = list.filter(r => r?.is_commander)
  const main = list.filter(r => !r?.is_commander && r?.board !== 'side' && r?.board !== 'maybe')
  const side = list.filter(r => !r?.is_commander && r?.board === 'side')

  const lines = mergedLines(main)
  const sideLines = mergedLines(side)
  const commanderLines = mergedLines(commander)
  if (sideLines.length) lines.push('', '// Sideboard', ...sideLines)
  if (commanderLines.length) lines.push('', '// Commander', ...commanderLines)
  return lines.join('\n').trim() + '\n'
}
