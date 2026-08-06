// Progress model for the Build Assistant's auto-fill.
//
// Auto-fill is a fixed sequence of phases, and — this is what makes a real
// percentage possible rather than a spinner with a number glued to it — WHICH
// phases will run is known before the run starts. The engine pass is lab-mode
// only, the combo pass is decided by the target bracket, the Game Changer
// top-up only happens at Bracket 4, and basics only when slots remain.
//
// Weights are round-trip counts, not guesses at seconds. Auto-fill is entirely
// network-bound (the local planning is microseconds against ~200ms per call),
// so "how many requests does this phase make" is the closest honest proxy for
// its share of the wall clock, and it is readable straight off the code rather
// than tuned until a bar looked smooth.
//
// The cost of one bulk add, which every card-adding phase pays:
//   1. recommendation metadata + display printings  (issued together = 1)
//   2. owned printing candidates
//   3. hydrate printings by id
//   4. insert deck_cards
export const ADD_UNITS = 4

// A pass that cuts before it adds also issues a delete.
const CUT_UNITS = 1
// The combo pass fetches combos for the populated deck before deciding.
const COMBO_FETCH_UNITS = 1

export const PHASE = {
  fill:    'fill',
  engine:  'engine',
  combo:   'combo',
  gc:      'gc',
  basics:  'basics',
}

const PHASE_LABELS = {
  fill:   'Choosing cards and resolving printings',
  engine: 'Covering what your commander needs',
  combo:  'Completing combos',
  gc:     'Topping up Game Changers',
  basics: 'Adding basic lands',
}

export function phaseLabel(id) {
  return PHASE_LABELS[id] || 'Building your deck'
}

/**
 * The phases a run will actually perform, with their weights.
 *
 * Everything here is decided before the first request, so the denominator never
 * moves mid-run — a bar whose total grows is worse than no bar, because it
 * reads as progress going backwards.
 *
 * `basicsExpected` is a prediction rather than a certainty (the exact count is
 * only known once the fill lands), so it is included whenever the plan leaves
 * room for lands at all. Over-including costs one phase's worth of bar that
 * completes instantly; under-including would make the bar finish before the
 * work does.
 */
export function planAutoFillPhases({
  enginePass = false,
  comboPassTarget = 0,
  targetBracket = null,
  hasGameChangers = false,
  basicsExpected = true,
} = {}) {
  const phases = [{ id: PHASE.fill, units: ADD_UNITS }]
  if (enginePass) phases.push({ id: PHASE.engine, units: ADD_UNITS + CUT_UNITS })
  if (comboPassTarget > 0) {
    phases.push({ id: PHASE.combo, units: COMBO_FETCH_UNITS + ADD_UNITS + CUT_UNITS })
  }
  if (targetBracket === 4 && hasGameChangers) {
    phases.push({ id: PHASE.gc, units: ADD_UNITS + CUT_UNITS })
  }
  if (basicsExpected) phases.push({ id: PHASE.basics, units: 1 })
  return phases
}

export function totalUnits(phases) {
  return (phases || []).reduce((sum, phase) => sum + (phase.units || 0), 0)
}

/**
 * Turn completed work into a percentage.
 *
 * Clamped and monotonic on purpose. A phase that is skipped at runtime (the
 * combo pass finds nothing to complete) would otherwise leave the bar short of
 * 100 while the UI says it finished, and a phase that reports more sub-steps
 * than budgeted would push it past. `done` is authoritative for ordering; the
 * caller keeps the max it has already shown.
 */
export function progressPercent(doneUnits, total) {
  if (!(total > 0)) return 0
  return Math.max(0, Math.min(100, Math.round((doneUnits / total) * 100)))
}

/**
 * Tracker over a phase plan. Deliberately tiny and synchronous — the run is a
 * sequence of awaits in one function, so there is nothing to reconcile.
 *
 * `phaseStep` reports progress WITHIN a phase (the bulk add's four requests);
 * `completePhase` closes it out and absorbs whatever sub-steps never arrived,
 * so a phase that short-circuits still lands exactly on its budget.
 */
export function createAutoFillProgress(phases) {
  const list = phases || []
  const total = totalUnits(list)
  let doneUnits = 0
  let phaseIndex = -1
  let phaseStart = 0
  let shown = 0

  function snapshot() {
    const raw = progressPercent(doneUnits, total)
    // Never let a percentage go down: skipped work resolves forward, and a bar
    // that retreats reads as a bug even when the number is defensible.
    shown = Math.max(shown, raw)
    const phase = list[phaseIndex] || null
    return { percent: shown, phase: phase?.id || null, label: phaseLabel(phase?.id) }
  }

  return {
    total,
    beginPhase(id) {
      const next = list.findIndex((phase, i) => phase.id === id && i > phaseIndex)
      if (next === -1) return snapshot()
      // Absorb any phases the plan expected but the run skipped, so their units
      // are not stranded and the bar can still reach 100.
      for (let i = phaseIndex + 1; i < next; i += 1) doneUnits += list[i].units || 0
      phaseIndex = next
      phaseStart = doneUnits
      return snapshot()
    },
    phaseStep(step, steps) {
      const phase = list[phaseIndex]
      if (!phase || !(steps > 0)) return snapshot()
      const fraction = Math.max(0, Math.min(1, step / steps))
      doneUnits = Math.max(doneUnits, phaseStart + fraction * (phase.units || 0))
      return snapshot()
    },
    completePhase() {
      const phase = list[phaseIndex]
      if (phase) doneUnits = Math.max(doneUnits, phaseStart + (phase.units || 0))
      return snapshot()
    },
    finish() {
      doneUnits = total
      return snapshot()
    },
    snapshot,
  }
}
