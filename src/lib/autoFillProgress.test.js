import { describe, expect, it } from 'vitest'
import {
  ADD_UNITS,
  PHASE,
  createAutoFillProgress,
  planAutoFillPhases,
  progressPercent,
  totalUnits,
} from './autoFillProgress'

describe('planAutoFillPhases', () => {
  it('plans just the fill and basics for a plain run', () => {
    const phases = planAutoFillPhases({ comboPassTarget: 0, basicsExpected: true })
    expect(phases.map(p => p.id)).toEqual([PHASE.fill, PHASE.basics])
  })

  // Bracket <= 2 allows no combos, so the pass no-ops — budgeting for it would
  // leave the bar parked short of 100 while the summary says it finished.
  it('omits the combo phase when the bracket allows no combos', () => {
    const phases = planAutoFillPhases({ comboPassTarget: 0 })
    expect(phases.some(p => p.id === PHASE.combo)).toBe(false)
  })

  it('includes every optional phase when all are in force', () => {
    const phases = planAutoFillPhases({
      enginePass: true, comboPassTarget: 2, targetBracket: 4, hasGameChangers: true,
    })
    expect(phases.map(p => p.id)).toEqual([
      PHASE.fill, PHASE.engine, PHASE.combo, PHASE.gc, PHASE.basics,
    ])
  })

  // Bracket 4 alone is not enough — the top-up needs the Game Changer list, and
  // that fetch is allowed to fail.
  it('omits the Game Changer phase when the list never loaded', () => {
    const phases = planAutoFillPhases({ targetBracket: 4, hasGameChangers: false })
    expect(phases.some(p => p.id === PHASE.gc)).toBe(false)
  })
})

describe('progressPercent', () => {
  it('clamps to 0-100 and tolerates a zero total', () => {
    expect(progressPercent(0, 0)).toBe(0)
    expect(progressPercent(-5, 10)).toBe(0)
    expect(progressPercent(50, 10)).toBe(100)
    expect(progressPercent(5, 10)).toBe(50)
  })
})

describe('createAutoFillProgress', () => {
  const phases = () => planAutoFillPhases({ comboPassTarget: 2, basicsExpected: true })

  it('reports sub-steps inside a phase', () => {
    const tracker = createAutoFillProgress(phases())
    tracker.beginPhase(PHASE.fill)
    expect(tracker.snapshot().percent).toBe(0)
    const half = tracker.phaseStep(ADD_UNITS / 2, ADD_UNITS)
    expect(half.percent).toBeGreaterThan(0)
    expect(half.percent).toBeLessThan(100)
    expect(half.phase).toBe(PHASE.fill)
  })

  it('never goes backwards', () => {
    const tracker = createAutoFillProgress(phases())
    tracker.beginPhase(PHASE.fill)
    const ahead = tracker.phaseStep(4, 4).percent
    // A late-arriving smaller step must not rewind the bar.
    expect(tracker.phaseStep(1, 4).percent).toBe(ahead)
  })

  // The combo pass can decide there is nothing to complete and return without
  // issuing a request. Its budget has to resolve forward or the bar strands.
  it('absorbs phases the run skipped', () => {
    const tracker = createAutoFillProgress(phases())
    tracker.beginPhase(PHASE.fill)
    tracker.completePhase()
    const atBasics = tracker.beginPhase(PHASE.basics)
    expect(atBasics.phase).toBe(PHASE.basics)
    // The skipped combo phase's units are behind us, not stranded.
    expect(atBasics.percent).toBeGreaterThan(progressPercent(ADD_UNITS, tracker.total))
  })

  it('always lands on exactly 100', () => {
    const tracker = createAutoFillProgress(phases())
    tracker.beginPhase(PHASE.fill)
    expect(tracker.finish().percent).toBe(100)
  })

  it('ignores a phase that is not in the plan', () => {
    const tracker = createAutoFillProgress(planAutoFillPhases({ comboPassTarget: 0 }))
    tracker.beginPhase(PHASE.fill)
    const before = tracker.snapshot().percent
    expect(tracker.beginPhase(PHASE.gc).percent).toBe(before)
  })

  it('sums plan weights into the total', () => {
    const plan = planAutoFillPhases({ comboPassTarget: 0, basicsExpected: true })
    expect(createAutoFillProgress(plan).total).toBe(totalUnits(plan))
  })
})
