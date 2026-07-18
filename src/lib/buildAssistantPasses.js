// Post-auto-fill passes for the Build Assistant, extracted from the component
// so the riskiest orchestration — the code that ADDS and DELETES deck cards —
// is directly testable. Every side effect is injected: `fetchCombos`,
// `addCards`, `removeCards`, and `analyzeCutFn` come from the component, which
// keeps its own thin wrappers that bind live state and fold returned rows into
// the session "added" set.

import { cardNameMatchKeys, countDeckCards } from './deckBuilderHelpers'
import {
  mapAlmostCombos,
  planComboCompletion,
  comboInColorIdentity,
  comboTargetForBracket,
} from './deckBuildAssistant'

/**
 * Post-fill combo completion. Re-queries Commander Spellbook on the just-
 * populated deck, completes as many bracket-appropriate combos as the target
 * allows (source-aware: 'owned' uses owned pieces only, 'recommended' may reach
 * for unowned pieces → buy list), and cuts an equal number of just-filled
 * filler cards so the deck size holds. Only cards THIS run added are cuttable —
 * never the user's existing cards, and never a piece of a combo being completed
 * — which also keeps undo coherent (undo returns to the pre-fill deck).
 *
 * @param {Object} args
 * @param {Array}    args.populated   [...deckCards, ...fillRows] — deck after the fill
 * @param {Array}    args.fillIds     ids of the rows this run added (the cuttable pool)
 * @param {?number}  args.targetBracket
 * @param {string}   args.source      'owned' | 'recommended'
 * @param {Array}    args.commanderColorIdentity
 * @param {Set}      args.ownedNameKeys  lowercased binder-available names
 * @param {number}   args.deckSize
 * @param {Function} args.isLandRow      (deckRow) => bool
 * @param {Function} args.fetchCombos    async (deck) => { almost } | null
 * @param {Function} args.passesBudget   (name) => bool
 * @param {Function} args.analyzeCutFn   ({ deckCards, totalCards, lockedIds }) => cut analysis
 * @param {Function} args.addCards       async (items) => { rows }
 * @param {Function} [args.removeCards]  async (ids) => removed ids | void
 * @returns {Promise<{comboRows: Array, cutIds: Array, combosCompleted: number}>}
 *          best-effort — zeros on any failure.
 */
export async function runComboPass({
  populated = [],
  fillIds = [],
  targetBracket = null,
  source = 'owned',
  commanderColorIdentity = [],
  ownedNameKeys = new Set(),
  deckSize = 100,
  isLandRow = () => false,
  fetchCombos,
  passesBudget = () => true,
  analyzeCutFn,
  addCards,
  removeCards,
} = {}) {
  const empty = { comboRows: [], cutIds: [], combosCompleted: 0 }
  if (comboTargetForBracket(targetBracket) <= 0) return empty
  if (typeof fetchCombos !== 'function' || typeof addCards !== 'function') return empty
  try {
    const res = await fetchCombos(populated)
    if (!res) return empty
    const deckKeys = new Set(
      populated.filter(d => !d?.is_commander).flatMap(d => cardNameMatchKeys(d?.name)),
    )
    // Only complete combos that live within the commander's color identity —
    // Spellbook's results include off-color "by adding colors" combos we must
    // not add. See comboInColorIdentity.
    const inIdentityAlmost = (res.almost || []).filter(c => comboInColorIdentity(c, commanderColorIdentity))
    const almost = mapAlmostCombos({
      almost: inIdentityAlmost,
      deckNameKeys: deckKeys,
      ownedNameKeys,
    })

    // Room the combo pass can absorb without cutting the user's existing cards:
    // the open slots the fill left, plus this run's cuttable (nonland) filler.
    // Capping combo pieces to this keeps the deck at ≤ deckSize — otherwise a
    // near-full deck could end above 100, since we only cut cards THIS run added.
    const fillSet = new Set(fillIds || [])
    // COPIES, not rows — a multi-qty basics row would otherwise make the deck
    // look emptier than it is and let combo pieces overfill it past deckSize.
    const populatedCount = countDeckCards(populated)
    const openSlots = Math.max(0, deckSize - populatedCount)
    const cuttableFillCount = protNames => populated.filter(d =>
      !d?.is_commander && fillSet.has(d.id) && !isLandRow(d)
      && !cardNameMatchKeys(d?.name).some(k => protNames.has(k))).length
    const planCombos = maxPieces => planComboCompletion({
      almostCombos: almost,
      targetBracket,
      source,
      deckNameKeys: deckKeys,
      passesBudget,
      maxPieces,
    })
    // Plan uncapped, then re-plan capped to the room if it wouldn't fit. Fewer
    // combos only free more cuttable filler, so a single re-plan is safe.
    let { pieces, combosCompleted, protectedNames } = planCombos(Infinity)
    if (pieces.length > openSlots + cuttableFillCount(protectedNames)) {
      ({ pieces, combosCompleted, protectedNames } = planCombos(openSlots + cuttableFillCount(protectedNames)))
    }
    if (!pieces.length) return { ...empty, combosCompleted }

    // Cuttable = this run's filler, minus any card that's a piece of a combo
    // we're completing. Lock everything else so the cut analysis only pulls
    // from it.
    const cuttableIds = new Set(
      populated
        .filter(d => !d?.is_commander && fillSet.has(d.id)
          && !cardNameMatchKeys(d?.name).some(k => protectedNames.has(k)))
        .map(d => d.id),
    )
    const lockedIds = new Set(
      populated.filter(d => !d?.is_commander && !cuttableIds.has(d.id)).map(d => d.id),
    )
    // over = (populated − deckSize) + pieces added → exactly the cuts needed to
    // hold the size, absorbing any open slots the fill left.
    const cut = analyzeCutFn({
      deckCards: populated,
      totalCards: populatedCount + pieces.length,
      lockedIds,
    })
    let cutIds = (cut?.recommended || []).map(r => r.id).filter(Boolean)
    if (cutIds.length && typeof removeCards === 'function') {
      try {
        // A parent that returns the ids it actually deleted (partial batch
        // failures) narrows our accounting to the real cuts; a void return
        // keeps the optimistic assumption.
        const removed = await removeCards(cutIds)
        if (Array.isArray(removed)) cutIds = removed
      } catch {
        cutIds = [] // nothing verifiably removed — don't report phantom cuts
      }
    } else {
      cutIds = [] // no removal path → no cuts happened
    }
    let comboRows = []
    try {
      const addRes = await addCards(pieces.map(p => ({ name: p.name })))
      comboRows = addRes?.rows || []
    } catch { /* parent surfaces errors */ }
    return { comboRows, cutIds, combosCompleted }
  } catch {
    return empty
  }
}

/**
 * Post-fill Game Changer top-up (Bracket 4 only). The estimator floors a deck
 * at Bracket 4 once it runs 4+ Game Changers, so a "target 4" build that landed
 * fewer would still read Bracket 3. Adds the shortfall from the commander's OWN
 * recommended pool (owned candidates first, then suggestion upgrades) — so the
 * picks stay on-theme and in color — capped to `maxAdd` slots the caller has
 * already reserved away from the basics top-up. Source-aware: 'owned' only
 * pulls owned Game Changers; 'recommended' upgrades are budget-gated.
 *
 * @returns {Promise<{gcRows: Array}>} best-effort — empty on any failure.
 */
export async function runGameChangerPass({
  populated = [],
  maxAdd = 0,
  targetBracket = null,
  source = 'owned',
  gameChangerNames = null,
  roles = [],
  upgradesFor = () => [],
  passesBudget = () => true,
  addCards,
} = {}) {
  const empty = { gcRows: [] }
  if (targetBracket !== 4 || !gameChangerNames || maxAdd <= 0 || typeof addCards !== 'function') return empty
  const isGC = name => {
    const l = String(name || '').toLowerCase()
    return gameChangerNames.has(l) || gameChangerNames.has(l.split('//')[0].trim())
  }
  const gcInDeck = new Set()
  for (const d of populated) {
    if (!d?.is_commander && isGC(d?.name)) gcInDeck.add(String(d.name).toLowerCase())
  }
  const need = 4 - gcInDeck.size
  if (need <= 0) return empty

  const deckKeys = new Set(populated.filter(d => !d?.is_commander).flatMap(d => cardNameMatchKeys(d?.name)))
  const seen = new Set()
  const owned = []
  const rec = []
  for (const role of roles) {
    for (const c of role.ownedCandidates || []) {
      const name = c?.name
      if (!name || !isGC(name)) continue
      const key = name.toLowerCase()
      if (seen.has(key) || deckKeys.has(key)) continue // owned copies aren't gated by budget
      seen.add(key)
      owned.push({ name, inclusion: c.edhrecInclusion || 0 })
    }
  }
  if (source === 'recommended') {
    for (const role of roles) {
      for (const u of upgradesFor(role) || []) {
        const name = u?.name
        if (!name || !isGC(name)) continue
        const key = name.toLowerCase()
        if (seen.has(key) || deckKeys.has(key) || !passesBudget(name)) continue
        seen.add(key)
        rec.push({ name, inclusion: u.edhrecInclusion || 0 })
      }
    }
  }
  owned.sort((a, b) => b.inclusion - a.inclusion)
  rec.sort((a, b) => b.inclusion - a.inclusion)
  const toAdd = [...owned, ...rec].slice(0, Math.min(need, maxAdd))
  if (!toAdd.length) return empty
  try {
    const addRes = await addCards(toAdd.map(g => ({ name: g.name })))
    return { gcRows: addRes?.rows || [] }
  } catch {
    return empty
  }
}
