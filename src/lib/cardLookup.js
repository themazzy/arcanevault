/**
 * Pure Scryfall query-building + autocomplete helpers for the Home page's
 * "Card Lookup" section. Split out from Home.jsx so this logic (and its
 * name-relevance fix) can be unit tested without dragging in the whole page's
 * dependency graph.
 */
import { searchCardNames } from './cardSearch'

// Returns card objects (with images) for the autocomplete dropdown.
// Served from our own oracle_cards table (name-anchored by design, ranked
// exact → prefix → fuzzy) with a Scryfall fallback inside the helper — so an
// exact match like "Void" always tops the list instead of being crowded out
// by oracle-text-only matches.
export async function fetchAutocomplete(q) {
  const term = q.trim()
  if (!term) return []
  return searchCardNames(term, { limit: 9 })
}

// ── Lookup filter helpers ─────────────────────────────────────────────────────
export function buildLookupQuery(search, filters) {
  const tokens = []
  // Anchored to `name:` rather than sent bare — oracle text has its own
  // dedicated filter below, so the plain search box is name-only.
  if (search?.trim()) tokens.push(`name:"${search.trim().replace(/"/g, '')}"`)

  if (filters.foil === 'foil') tokens.push('is:foil')
  if (filters.foil === 'nonfoil') tokens.push('is:nonfoil')
  if (filters.foil === 'etched') tokens.push('is:etched')

  if (filters.colors?.length) {
    const selected = filters.colors.filter(c => ['W','U','B','R','G'].includes(c))
    if (selected.length) {
      const colorString = selected.join('')
      if (filters.colorMode === 'exact') tokens.push(`id=${colorString}`)
      else if (filters.colorMode === 'including') tokens.push(`id>=${colorString}`)
      else tokens.push(`id:${colorString}`)
    }
    if (filters.colors.includes('C')) tokens.push('id:c')
    if (filters.colors.includes('M')) tokens.push('id>1')
  }

  if (filters.colorCountMin > 0) tokens.push(`colors>=${filters.colorCountMin}`)
  if (filters.colorCountMax < 5) tokens.push(`colors<=${filters.colorCountMax}`)
  filters.rarity?.forEach(r => tokens.push(`rarity:${r}`))
  filters.typeLine?.forEach(t => tokens.push(`type:"${t}"`))
  if (filters.oracleText?.trim()) tokens.push(`oracle:"${filters.oracleText.trim()}"`)
  if (filters.artist?.trim()) tokens.push(`artist:"${filters.artist.trim()}"`)
  filters.formats?.forEach(f => tokens.push(`format:${f}`))
  filters.sets?.forEach(s => tokens.push(`set:${s}`))

  const numericFilters = [
    ['cmc', filters.cmcOp, filters.cmcMin, filters.cmcMax],
    ['pow', filters.powerOp, filters.powerVal, filters.powerVal2],
    ['tou', filters.toughOp, filters.toughVal, filters.toughVal2],
  ]
  for (const [field, op, val, val2] of numericFilters) {
    if (!op || op === 'any') continue
    if (op === 'between') {
      if (val !== '') tokens.push(`${field}>=${val}`)
      if (val2 !== '') tokens.push(`${field}<=${val2}`)
    } else if (op === 'in') {
      String(val || '').split(',').map(v => v.trim()).filter(Boolean).forEach(v => tokens.push(`${field}:${v}`))
    } else if (val !== '') {
      tokens.push(`${field}${op}${val}`)
    }
  }

  return tokens.join(' ')
}

export function hasLookupFilters(filters) {
  return buildLookupQuery('', filters).trim().length > 0
}
