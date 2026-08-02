import { describe, it, expect } from 'vitest'
import {
  deriveProposalSides,
  isProposalClosed,
  nextProposalAction,
  matchGiveToOwnedRows,
  pickPrintingForReceive,
  receiveCardNames,
  sortProposals,
  countActionable,
} from './tradeProposals'

const BOLT = { name: 'Lightning Bolt', set_code: 'lea', collector_number: '161', foil: false }
const SOL = { name: 'Sol Ring', set_code: 'c21', collector_number: '263', foil: true }

const row = (over = {}) => ({
  id: 'r1', cardId: 'c1', name: 'Lightning Bolt', setCode: 'lea', collectorNumber: '161',
  foil: false, sourceId: 'binder-a', sourceType: 'binder', sourceName: 'Main', qty: 1, ...over,
})

describe('deriveProposalSides', () => {
  it('gives the owner the requested cards and receives the offered ones', () => {
    const sides = deriveProposalSides({ is_owner: true, requested: [BOLT], offered: [SOL] })
    expect(sides.give).toEqual([BOLT])
    expect(sides.receive).toEqual([SOL])
  })

  it('inverts the sides for the proposer', () => {
    const sides = deriveProposalSides({ is_owner: false, requested: [BOLT], offered: [SOL] })
    expect(sides.give).toEqual([SOL])
    expect(sides.receive).toEqual([BOLT])
  })

  it('tolerates missing payloads', () => {
    expect(deriveProposalSides({ is_owner: true })).toEqual({ give: [], receive: [] })
    expect(deriveProposalSides(null)).toEqual({ give: [], receive: [] })
  })
})

describe('nextProposalAction', () => {
  it('lets the owner respond and the proposer cancel while pending', () => {
    expect(nextProposalAction({ status: 'pending', is_owner: true })).toBe('respond')
    expect(nextProposalAction({ status: 'pending', is_owner: false })).toBe('cancel')
  })

  it('offers completion once accepted, to either side', () => {
    expect(nextProposalAction({ status: 'accepted', is_owner: true })).toBe('complete')
    expect(nextProposalAction({ status: 'accepted', is_owner: false })).toBe('complete')
  })

  it('tracks settlement per viewer, not per proposal', () => {
    const base = { status: 'completed', is_owner: true }
    expect(nextProposalAction({ ...base, my_settled: false, their_settled: true })).toBe('settle')
    expect(nextProposalAction({ ...base, my_settled: true, their_settled: false })).toBe('done')
  })

  it('has nothing to offer on closed proposals', () => {
    expect(nextProposalAction({ status: 'declined', is_owner: true })).toBe('none')
    expect(nextProposalAction({ status: 'cancelled', is_owner: false })).toBe('none')
  })
})

describe('isProposalClosed', () => {
  it('treats only declined and cancelled as closed', () => {
    expect(isProposalClosed('declined')).toBe(true)
    expect(isProposalClosed('cancelled')).toBe(true)
    expect(isProposalClosed('completed')).toBe(false)
    expect(isProposalClosed('accepted')).toBe(false)
  })
})

describe('matchGiveToOwnedRows', () => {
  it('matches an exact printing', () => {
    const { matched, unmatched } = matchGiveToOwnedRows([BOLT], [row()])
    expect(unmatched).toHaveLength(0)
    expect(matched[0].row.id).toBe('r1')
    expect(matched[0].qty).toBe(1)
  })

  it('prefers the For Trade binder when a card sits in several folders', () => {
    const rows = [row({ id: 'other', sourceId: 'binder-a' }), row({ id: 'trade', sourceId: 'trade-binder' })]
    const { matched } = matchGiveToOwnedRows([BOLT], rows, { preferSourceId: 'trade-binder' })
    expect(matched[0].row.id).toBe('trade')
  })

  it('falls back to a name match when the entry is free text', () => {
    const freeText = { name: 'lightning bolt' }
    const { matched, unmatched } = matchGiveToOwnedRows([freeText], [row()])
    expect(unmatched).toHaveLength(0)
    expect(matched[0].row.id).toBe('r1')
  })

  it('prefers the matching foil when both finishes are owned', () => {
    const rows = [row({ id: 'nonfoil', foil: false }), row({ id: 'foiled', foil: true })]
    const { matched } = matchGiveToOwnedRows([{ ...BOLT, foil: true }], rows)
    expect(matched[0].row.id).toBe('foiled')
  })

  it('reports cards it cannot place instead of dropping them', () => {
    const { matched, unmatched } = matchGiveToOwnedRows([SOL], [row()])
    expect(matched).toHaveLength(0)
    expect(unmatched).toEqual([{ card: SOL, missingQty: 1 }])
  })

  it('does not resolve two copies onto the same single-copy placement', () => {
    const { matched, unmatched } = matchGiveToOwnedRows([{ ...BOLT, qty: 2 }], [row({ qty: 1 })])
    expect(matched).toHaveLength(1)
    expect(matched[0].qty).toBe(1)
    expect(unmatched).toEqual([{ card: { ...BOLT, qty: 2 }, missingQty: 1 }])
  })

  it('draws multiple copies from one placement that has them', () => {
    const { matched, unmatched } = matchGiveToOwnedRows([{ ...BOLT, qty: 3 }], [row({ qty: 4 })])
    expect(unmatched).toHaveLength(0)
    expect(matched).toEqual([expect.objectContaining({ qty: 3 })])
  })
})

describe('pickPrintingForReceive', () => {
  const prints = [
    { id: 'p-old', name: 'Sol Ring', set: 'c13', collector_number: '250', released_at: '2013-11-01' },
    { id: 'p-new', name: 'Sol Ring', set: 'c21', collector_number: '263', released_at: '2021-04-23' },
    { id: 'p-other', name: 'Lightning Bolt', set: 'lea', collector_number: '161', released_at: '1993-08-05' },
  ]

  it('honours an exact scryfall id', () => {
    expect(pickPrintingForReceive({ name: 'Sol Ring', scryfall_id: 'p-old' }, prints).id).toBe('p-old')
  })

  it('falls back to set and collector number', () => {
    expect(pickPrintingForReceive({ name: 'Sol Ring', set_code: 'c13', collector_number: '250' }, prints).id).toBe('p-old')
  })

  it('guesses the newest printing for a bare name', () => {
    expect(pickPrintingForReceive({ name: 'Sol Ring' }, prints).id).toBe('p-new')
  })

  it('never crosses over to a different card name', () => {
    expect(pickPrintingForReceive({ name: 'Sol Ring' }, prints).name).toBe('Sol Ring')
  })

  it('returns null when nothing is available', () => {
    expect(pickPrintingForReceive({ name: 'Sol Ring' }, [])).toBeNull()
  })
})

const p = (id, over) => ({ id, created_at: '2026-01-01T00:00:00Z', ...over })

describe('sortProposals', () => {
  const sort = sortProposals

  it('floats what needs an answer above everything else', () => {
    const incoming = [
      p('done', { is_owner: true, status: 'completed', my_settled: true }),
      p('respond', { is_owner: true, status: 'pending' }),
    ]
    const outgoing = [p('settle', { is_owner: false, status: 'completed', my_settled: false })]
    expect(sort(incoming, outgoing).map(x => x.id)).toEqual(['respond', 'settle', 'done'])
  })

  it('sinks declined and cancelled to the bottom', () => {
    const rows = sort(
      [p('dead', { is_owner: true, status: 'declined' })],
      [p('live', { is_owner: false, status: 'accepted' })],
    )
    expect(rows.map(x => x.id)).toEqual(['live', 'dead'])
  })

  it('breaks ties by newest first', () => {
    const rows = sort([
      p('older', { is_owner: true, status: 'pending', created_at: '2026-01-01T00:00:00Z' }),
      p('newer', { is_owner: true, status: 'pending', created_at: '2026-06-01T00:00:00Z' }),
    ], [])
    expect(rows.map(x => x.id)).toEqual(['newer', 'older'])
  })

  it('interleaves both directions rather than grouping them', () => {
    const rows = sort(
      [p('in-old', { is_owner: true, status: 'pending', created_at: '2026-01-01T00:00:00Z' })],
      [p('out-new', { is_owner: false, status: 'pending', created_at: '2026-06-01T00:00:00Z' })],
    )
    // Sent-pending is 'cancel' priority, which ranks below an unanswered inbound.
    expect(rows.map(x => x.id)).toEqual(['in-old', 'out-new'])
  })
})

describe('countActionable', () => {
  it('counts only what the viewer can act on, across both directions', () => {
    const incoming = [
      p('a', { is_owner: true, status: 'pending' }),            // respond
      p('b', { is_owner: true, status: 'declined' }),           // none
      p('c', { is_owner: true, status: 'completed', my_settled: true }), // done
    ]
    const outgoing = [
      p('d', { is_owner: false, status: 'completed', my_settled: false }), // settle
      p('e', { is_owner: false, status: 'accepted' }),          // complete
      p('f', { is_owner: false, status: 'pending' }),           // cancel — not urgent
    ]
    expect(countActionable(incoming, outgoing)).toBe(3)
  })

  it('is zero for an empty inbox', () => {
    expect(countActionable([], [])).toBe(0)
    expect(countActionable(null, undefined)).toBe(0)
  })
})

describe('receiveCardNames', () => {
  it('dedupes, trims and drops blanks', () => {
    expect(receiveCardNames([{ name: ' Sol Ring ' }, { name: 'Sol Ring' }, { name: '' }, {}]))
      .toEqual(['Sol Ring'])
  })
})
