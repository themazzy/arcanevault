/**
 * Client-side filter for a card's printing list — the "which of these 60
 * Sol Rings do I own" problem. Shared by the scanner's printing picker and
 * AddCardModal so both boxes accept the same queries.
 *
 * Matches a plain substring against the set name, the set code and the release
 * year, plus a prefix match on the collector number (prefix, not substring, so
 * typing `25` doesn't drag in every `#125`/`#250`). A leading `#` is stripped
 * and narrows the query to the number alone, the way it's printed on the card.
 */

function normalize(value) {
  return value == null ? '' : String(value).toLowerCase()
}

/** True when `printing` matches `query` (an empty/blank query matches everything). */
export function matchesPrintingFilter(printing, query) {
  const q = normalize(query).trim()
  if (!q) return true
  if (!printing) return false

  const bare = q.startsWith('#') ? q.slice(1) : q
  if (bare && normalize(printing.collector_number).startsWith(bare)) return true
  if (q.startsWith('#')) return false   // `#…` only ever addresses the number

  return normalize(printing.set_name).includes(q) ||
    normalize(printing.set).includes(q) ||
    normalize(printing.set_code).includes(q) ||
    normalize(printing.released_at).slice(0, 4).includes(q)
}

/** Filtered copy of `printings`; returns the same array when the query is blank. */
export function filterPrintings(printings, query) {
  const list = Array.isArray(printings) ? printings : []
  if (!normalize(query).trim()) return list
  return list.filter(p => matchesPrintingFilter(p, query))
}
