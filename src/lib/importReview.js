/**
 * Shaping helpers for the import review/preview list.
 *
 * The review screen answers one question — "is this what I meant to import,
 * and is anything wrong?" — so it has to lead with the answer and spend its
 * width on what varies. The old layout did neither: four stat tiles carrying
 * near-duplicate numbers (`unique` and `matched` are equal whenever nothing
 * failed), and two columns repeating an identical value down every row while
 * the card name — the only thing identifying a row — was clipped.
 *
 * Kept pure so the wording and ordering are testable without mounting a modal.
 */

export const REVIEW_ISSUE = { MISSING: 'missing', NOTE: 'note' }

/** null when the row is a clean, unambiguous match. */
export function reviewRowIssue(row) {
  if (!row || row.status !== 'matched' || !row.sfCard) return REVIEW_ISSUE.MISSING
  if (row.matchNote) return REVIEW_ISSUE.NOTE
  return null
}

const ISSUE_RANK = { [REVIEW_ISSUE.MISSING]: 0, [REVIEW_ISSUE.NOTE]: 1 }
const rankOf = (row) => ISSUE_RANK[reviewRowIssue(row)] ?? 2

/**
 * Rows paired with their index in the ORIGINAL array, ordered problems-first so
 * three bad rows in four hundred are visible without scrolling. Clean rows keep
 * the order they were pasted in.
 *
 * The original index has to survive the sort — callers edit rows by position.
 */
export function orderReviewRows(rows) {
  return (rows || [])
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rankOf(a.row) - rankOf(b.row) || a.index - b.index)
}

export function describeReviewRows(rows) {
  const list = rows || []
  let missingRows = 0
  let noteRows = 0
  let copies = 0
  let matchedRows = 0
  let matchedCopies = 0

  for (const row of list) {
    const qty = row.qty || 0
    copies += qty
    const issue = reviewRowIssue(row)
    if (issue === REVIEW_ISSUE.MISSING) { missingRows++; continue }
    if (issue === REVIEW_ISSUE.NOTE) noteRows++
    matchedRows++
    matchedCopies += qty
  }

  return { total: list.length, copies, matchedRows, matchedCopies, missingRows, noteRows }
}

/**
 * The single status line that replaces the tile grid. Card count is the count
 * that will actually import, so it always agrees with the Import button.
 */
export function reviewHeadline(desc) {
  if (!desc || !desc.total) return null

  const base = `${desc.matchedCopies} card${desc.matchedCopies === 1 ? '' : 's'} · ${desc.total} unique`

  if (desc.missingRows) {
    return {
      tone: 'error',
      text: `${base} · ${desc.missingRows} unresolved, will be skipped`,
    }
  }
  if (desc.noteRows) {
    return {
      tone: 'warn',
      text: `${base} · ${desc.noteRows} name${desc.noteRows === 1 ? '' : 's'} to check`,
    }
  }
  return { tone: 'success', text: `${base} · all matched` }
}

/**
 * The value every row shares, or null when they differ. A column whose value is
 * the same on every row carries no information — it belongs in a footnote under
 * the list, not in a column competing with the card name for width.
 */
export function uniformValue(rows, pick) {
  if (!rows || !rows.length) return null
  const first = pick(rows[0])
  if (first == null || first === '') return null
  for (const row of rows) if (pick(row) !== first) return null
  return first
}

/** Joins the demoted constants into the line under the list. */
export function reviewFootnote(parts) {
  const kept = (parts || []).filter(Boolean)
  return kept.length ? kept.join(' · ') : ''
}

/**
 * Scryfall reports foil availability two ways depending on how old the record
 * is — `finishes` on modern rows, a non-null foil price on older ones. Etched
 * counts: it is a foil finish for our purposes.
 */
export function printingHasFoil(printing) {
  return !!(
    printing?.finishes?.includes('foil') ||
    printing?.finishes?.includes('etched') ||
    printing?.prices?.eur_foil ||
    printing?.prices?.usd_foil
  )
}

/**
 * Re-point a resolved row at a printing the user picked by hand. Foil is
 * clamped to what the chosen printing actually offers — picking a non-foil-only
 * printing must not leave a foil flag behind.
 */
export function applyPrintingChoice(row, printing, foil) {
  if (!row || !printing) return row
  return {
    ...row,
    setCode: printing.set || null,
    collectorNumber: printing.collector_number || null,
    foil: !!foil && printingHasFoil(printing),
    sfCard: printing,
    resolvedName: printing.name || row.name,
    resolvedSetCode: printing.set || null,
    resolvedCollectorNumber: printing.collector_number || null,
    exactPrinting: true,
    status: 'matched',
    reason: null,
    matchNote: null,
  }
}

/**
 * Strip the resolution back off a row, leaving the user's chosen print
 * coordinates. This is what goes back into the un-resolved entry list so a
 * later re-resolve starts from the hand-picked printing rather than the
 * originally typed one.
 */
export function clearResolution(row) {
  return {
    ...row,
    sfCard: undefined,
    status: undefined,
    reason: undefined,
    resolvedName: undefined,
    resolvedSetCode: undefined,
    resolvedCollectorNumber: undefined,
    exactPrinting: undefined,
    matchNote: undefined,
  }
}
