import { describe, it, expect } from 'vitest'
import {
  REVIEW_ISSUE,
  describeReviewRows,
  orderReviewRows,
  reviewFootnote,
  reviewHeadline,
  reviewRowIssue,
  uniformValue,
} from './importReview'

const clean = (name, extra = {}) => ({
  name, qty: 1, status: 'matched', sfCard: { id: `sf-${name}` }, exactPrinting: true, ...extra,
})
const fuzzy = (name, extra = {}) => clean(name, { matchNote: 'approximate', exactPrinting: false, ...extra })
const missing = (name, extra = {}) => ({ name, qty: 1, status: 'missing', sfCard: null, ...extra })

describe('reviewRowIssue', () => {
  it('reports nothing for a clean match', () => {
    expect(reviewRowIssue(clean('Sol Ring'))).toBeNull()
  })

  it('separates a fuzzy match from a hard miss', () => {
    expect(reviewRowIssue(fuzzy('Solring'))).toBe(REVIEW_ISSUE.NOTE)
    expect(reviewRowIssue(missing('Asdfgh'))).toBe(REVIEW_ISSUE.MISSING)
  })

  it('treats a matched row with no card as missing', () => {
    // status says matched but the payload never arrived — importing it would
    // throw, so it has to read as a problem.
    expect(reviewRowIssue({ status: 'matched', sfCard: null })).toBe(REVIEW_ISSUE.MISSING)
  })
})

describe('orderReviewRows', () => {
  it('floats problems to the top, missing before fuzzy', () => {
    const rows = [clean('A'), fuzzy('B'), clean('C'), missing('D')]
    expect(orderReviewRows(rows).map(e => e.row.name)).toEqual(['D', 'B', 'A', 'C'])
  })

  it('keeps the pasted order within each group', () => {
    const rows = [missing('M1'), clean('C1'), missing('M2'), clean('C2')]
    expect(orderReviewRows(rows).map(e => e.row.name)).toEqual(['M1', 'M2', 'C1', 'C2'])
  })

  it('carries the original index through the sort', () => {
    // Callers edit rows by position, so the index has to survive reordering or
    // an edit lands on the wrong card.
    const rows = [clean('A'), clean('B'), missing('C')]
    const ordered = orderReviewRows(rows)
    expect(ordered[0]).toEqual({ row: rows[2], index: 2 })
    expect(ordered.map(e => rows[e.index])).toEqual(ordered.map(e => e.row))
  })

  it('handles an empty list', () => {
    expect(orderReviewRows([])).toEqual([])
    expect(orderReviewRows(undefined)).toEqual([])
  })
})

describe('describeReviewRows', () => {
  it('counts copies and rows separately', () => {
    const rows = [clean('A', { qty: 4 }), clean('B', { qty: 1 }), missing('C', { qty: 2 })]
    expect(describeReviewRows(rows)).toEqual({
      total: 3, copies: 7, matchedRows: 2, matchedCopies: 5, missingRows: 1, noteRows: 0,
    })
  })

  it('counts a fuzzy match as matched but flags it', () => {
    const desc = describeReviewRows([fuzzy('A', { qty: 3 })])
    expect(desc.matchedRows).toBe(1)
    expect(desc.matchedCopies).toBe(3)
    expect(desc.noteRows).toBe(1)
  })
})

describe('reviewHeadline', () => {
  it('says nothing for an empty list', () => {
    expect(reviewHeadline(describeReviewRows([]))).toBeNull()
  })

  it('confirms a clean import', () => {
    const line = reviewHeadline(describeReviewRows([clean('A', { qty: 100 }), clean('B')]))
    expect(line.tone).toBe('success')
    expect(line.text).toBe('101 cards · 2 unique · all matched')
  })

  it('leads with the unresolved count and says they will be skipped', () => {
    const line = reviewHeadline(describeReviewRows([clean('A'), missing('B'), missing('C')]))
    expect(line.tone).toBe('error')
    expect(line.text).toContain('2 unresolved, will be skipped')
  })

  it('warns about fuzzy names when nothing outright failed', () => {
    const line = reviewHeadline(describeReviewRows([clean('A'), fuzzy('B')]))
    expect(line.tone).toBe('warn')
    expect(line.text).toContain('1 name to check')
  })

  it('reports the count that will actually import, so it agrees with the button', () => {
    const line = reviewHeadline(describeReviewRows([clean('A', { qty: 4 }), missing('B', { qty: 9 })]))
    expect(line.text).toMatch(/^4 cards/)
  })

  it('prefers the hard failure over the fuzzy warning', () => {
    expect(reviewHeadline(describeReviewRows([fuzzy('A'), missing('B')])).tone).toBe('error')
  })
})

describe('uniformValue', () => {
  it('returns the shared value', () => {
    expect(uniformValue([{ b: 'main' }, { b: 'main' }], r => r.b)).toBe('main')
  })

  it('returns null as soon as one row differs', () => {
    expect(uniformValue([{ b: 'main' }, { b: 'side' }], r => r.b)).toBeNull()
  })

  it('treats absent and empty as not uniform', () => {
    expect(uniformValue([{ b: null }, { b: null }], r => r.b)).toBeNull()
    expect(uniformValue([{ b: '' }], r => r.b)).toBeNull()
    expect(uniformValue([], r => r.b)).toBeNull()
  })
})

describe('reviewFootnote', () => {
  it('joins only the parts that survived', () => {
    expect(reviewFootnote(['Mainboard', null, 'exact prints'])).toBe('Mainboard · exact prints')
  })

  it('is empty when nothing was demoted', () => {
    expect(reviewFootnote([null, null])).toBe('')
    expect(reviewFootnote()).toBe('')
  })
})
