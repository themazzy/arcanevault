// Scryfall-style color-identity matcher. Mirrors how Scryfall composes color
// filters in its query syntax: WUBRG + a mode (identity / including / exact)
// form a base predicate, and the M (multi-color, id>1) and C (colorless, id:c)
// chips layer in as AND constraints — the same semantics you get from typing
// `id=WU id>1` or `id<=W id:c` into Scryfall's search box.
//
// Modes:
//   identity  → Scryfall `id<=` / `id:` — color identity is a SUBSET of the
//               selected colors, i.e. the card is playable in a commander deck
//               of exactly those colors (e.g. id:RG matches mono-R, mono-G, RG,
//               and colorless cards, but not anything touching a 4th color).
//   including → Scryfall `id>=` — color identity is a SUPERSET of the selection.
//   exact     → Scryfall `id=`  — color identity equals the selection exactly.
//
// Behavioural summary:
//   ci=[W,U] + colors=[W,U] + mode=exact          → true   (exact match)
//   ci=[W]   + colors=[W,U] + mode=exact          → false
//   ci=[R,G] + colors=[R,G] + mode=identity       → true   (subset of itself)
//   ci=[R,G,W] + colors=[R,G] + mode=identity     → false  (W outside selection)
//   ci=[R]   + colors=[R,G] + mode=identity       → true   (subset)
//   ci=[]    + colors=[R,G] + mode=identity       → true   (colorless is in any)
//   ci=[U,G] + colors=[W]   + mode=any            → false  (no overlap)
//   ci=[W,U] + colors=[W]   + mode=including      → true
//   ci=[W,U] + colors=[W,M] + mode=exact          → false  (not exactly W)
//   ci=[W,U] + colors=[W,M] + mode=including      → true   (W in ci AND multi)
//   ci=[]    + colors=[C]                         → true
//   ci=[W]   + colors=[C]                         → false
//   ci=[W,U] + colors=[M]                         → true
//   ci=[W]   + colors=[M]                         → false
//   ci=[W,U] + colors=[M,C]                       → false  (impossible AND)
const WUBRG = new Set(['W', 'U', 'B', 'R', 'G'])

export function colorIdentityMatches(ci, colors, colorMode) {
  if (!colors || colors.length === 0) return true
  const identity = ci || []
  const wantsMulti     = colors.includes('M')
  const wantsColorless = colors.includes('C')
  const selected = colors.filter(x => WUBRG.has(x))

  // AND constraints first — they short-circuit cheaply.
  if (wantsMulti     && identity.length <= 1) return false
  if (wantsColorless && identity.length !== 0) return false

  if (!selected.length) return true

  if (colorMode === 'exact') {
    return identity.length === selected.length && selected.every(x => identity.includes(x))
  }
  if (colorMode === 'including') {
    return selected.every(x => identity.includes(x))
  }
  if (colorMode === 'identity') {
    // Subset: every color in the card's identity must be among the selection,
    // so the card is castable in a commander deck of those colors.
    return identity.every(x => selected.includes(x))
  }
  // 'any' (legacy fallback) — at least one of the selected colors present.
  return selected.some(x => identity.includes(x))
}
