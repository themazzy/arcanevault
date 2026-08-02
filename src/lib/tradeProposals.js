// Pure helpers for turning a trade proposal into the two sides of a Compare-tab
// trade. No I/O — everything here is fed already-loaded data so it can be tested
// directly and reused by both the inbox UI and the settle prefill.
//
// Proposal payloads are stored proposer-relative: `requested` is what the
// proposer asked the owner for, `offered` is what the proposer puts up. Both
// sides read the same row, so every give/receive question routes through
// deriveProposalSides rather than being re-derived per call site.

export const PROPOSAL_STAGES = ['pending', 'accepted', 'completed']

/** Cards the viewer gives away vs. receives, from their own point of view. */
export function deriveProposalSides(proposal) {
  const requested = Array.isArray(proposal?.requested) ? proposal.requested : []
  const offered = Array.isArray(proposal?.offered) ? proposal.offered : []
  return proposal?.is_owner
    ? { give: requested, receive: offered }
    : { give: offered, receive: requested }
}

/** Terminal proposals can't be acted on any further. */
export function isProposalClosed(status) {
  return status === 'declined' || status === 'cancelled'
}

/**
 * Which action the viewer can take next.
 *   respond  — owner decides on a pending proposal
 *   cancel   — proposer withdraws their own pending proposal
 *   complete — either party confirms the physical trade happened
 *   settle   — trade happened, viewer hasn't applied it to their collection yet
 *   done     — viewer has settled; nothing left to do
 *   none     — declined/cancelled, or waiting on the other party
 */
export function nextProposalAction(proposal) {
  const status = proposal?.status
  if (status === 'pending') return proposal?.is_owner ? 'respond' : 'cancel'
  if (status === 'accepted') return 'complete'
  if (status === 'completed') return proposal?.my_settled ? 'done' : 'settle'
  return 'none'
}

// Received and sent render as one list — direction is a property of a row, not
// a place to navigate to. Anything waiting on the viewer sorts to the top so the
// list itself answers "what do I need to do".
const ACTION_ORDER = { respond: 0, settle: 1, complete: 2, cancel: 3, done: 4, none: 5 }

export function sortProposals(incoming, outgoing) {
  return [...(incoming || []), ...(outgoing || [])].sort((a, b) => {
    const rank = ACTION_ORDER[nextProposalAction(a)] - ACTION_ORDER[nextProposalAction(b)]
    if (rank !== 0) return rank
    return String(b.created_at || '').localeCompare(String(a.created_at || ''))
  })
}

/** Proposals waiting on the viewer — drives the Proposals tab badge. */
export function countActionable(incoming, outgoing) {
  return [...(incoming || []), ...(outgoing || [])]
    .filter(p => ['respond', 'settle', 'complete'].includes(nextProposalAction(p)))
    .length
}

const norm = (v) => (v == null ? '' : String(v)).trim().toLowerCase()

/**
 * Match cards the viewer is giving away against their owned placement rows
 * (the `tradeSearchRows` shape from Trading.jsx: one row per card-per-folder).
 *
 * Proposal cards from the owner's For Trade binder carry a full print identity,
 * but a proposer's `offered` entries are free text — so this degrades from exact
 * print match down to a name match, and reports anything it could not place
 * instead of silently dropping it.
 *
 * `preferSourceId` biases toward a specific folder (the For Trade binder) when
 * the same card sits in several places.
 */
export function matchGiveToOwnedRows(giveCards, rows, { preferSourceId = null } = {}) {
  const matched = []
  const unmatched = []
  // Rows are consumed as they're used so two copies of a card in one proposal
  // don't both resolve onto the same placement.
  const remaining = (rows || []).map(r => ({ ...r, left: r.qty || 0 }))

  const score = (row, card) => {
    const sameFoil = !!row.foil === !!card.foil
    const samePrint = norm(row.setCode) === norm(card.set_code)
      && norm(row.collectorNumber) === norm(card.collector_number)
      && !!card.set_code
    const sameName = norm(row.name) === norm(card.name) && !!card.name
    if (!samePrint && !sameName) return -1
    let s = 0
    if (samePrint) s += 4
    if (sameName) s += 2
    if (sameFoil) s += 1
    if (preferSourceId && row.sourceId === preferSourceId) s += 8
    return s
  }

  for (const card of giveCards || []) {
    const qty = Math.max(1, Number(card.qty) || 1)
    let need = qty
    while (need > 0) {
      let best = null
      let bestScore = -1
      for (const row of remaining) {
        if (row.left <= 0) continue
        const s = score(row, card)
        if (s > bestScore || (s === bestScore && best && row.left > best.left)) {
          if (s < 0) continue
          best = row
          bestScore = s
        }
      }
      if (!best) break
      const take = Math.min(need, best.left)
      best.left -= take
      matched.push({ card, row: best, qty: take })
      need -= take
    }
    if (need > 0) unmatched.push({ card, missingQty: need })
  }

  return { matched, unmatched }
}

/**
 * Pick the printing to prefill for a card the viewer is receiving.
 * Exact scryfall id wins, then set + collector number, then the newest print of
 * that name — the receive side is often just a name, so this is a best guess the
 * user is expected to review before completing the trade.
 */
export function pickPrintingForReceive(card, printings) {
  const pool = (printings || []).filter(p => norm(p.name) === norm(card?.name))
  const candidates = pool.length ? pool : (printings || [])
  if (!candidates.length) return null

  if (card?.scryfall_id) {
    const exact = candidates.find(p => p.id === card.scryfall_id)
    if (exact) return exact
  }
  if (card?.set_code) {
    const byPrint = candidates.find(p =>
      norm(p.set) === norm(card.set_code) &&
      norm(p.collector_number) === norm(card.collector_number))
    if (byPrint) return byPrint
  }
  return [...candidates].sort((a, b) =>
    String(b.released_at || '').localeCompare(String(a.released_at || '')))[0] || null
}

/** Distinct, trimmed card names on a side — the input to a printings lookup. */
export function receiveCardNames(receiveCards) {
  return [...new Set((receiveCards || [])
    .map(c => (c?.name || '').trim())
    .filter(Boolean))]
}
