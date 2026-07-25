import { describe, it, expect, beforeEach, vi } from 'vitest'
import { checkAndNotifyMilestones, getUnlockedSet } from './milestoneTracker'
import { MILESTONES } from './milestones'

// Milestone ids used below, resolved from the real list so a renamed milestone
// fails loudly here instead of silently weakening the test.
const FIRST_CARD = MILESTONES.find(m => m.check({ total_cards: 1 }, {}))?.id
const AT_TEN = MILESTONES.find(m => !m.check({ total_cards: 1 }, {}) && m.check({ total_cards: 10 }, {}))?.id

const USER = 'user-1'
const KEY = `arcanevault_unlocked_milestones_${USER}`

// Tests run on the `node` environment (see vite.config.js), so there is no
// localStorage — same map-backed stand-in accountReset.test.js uses.
beforeEach(() => {
  const store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
    clear: () => { store.clear() },
  })
})

describe('checkAndNotifyMilestones', () => {
  it('adopts already-earned milestones silently on a device s first run', () => {
    const onUnlock = vi.fn()

    const unlocked = checkAndNotifyMilestones({ stats: { total_cards: 10 }, profile: {}, userId: USER, onUnlock })

    // Nothing is announced — otherwise an existing collection would fire every
    // milestone it has ever earned the first time it loads on a new device.
    expect(unlocked).toEqual([])
    expect(onUnlock).not.toHaveBeenCalled()
    expect(getUnlockedSet(USER).has(FIRST_CARD)).toBe(true)
    expect(getUnlockedSet(USER).has(AT_TEN)).toBe(true)
  })

  it('reports only newly earned milestones on later runs', () => {
    localStorage.setItem(KEY, JSON.stringify([FIRST_CARD]))
    const onUnlock = vi.fn()

    const unlocked = checkAndNotifyMilestones({ stats: { total_cards: 10 }, profile: {}, userId: USER, onUnlock })

    expect(unlocked).toContain(AT_TEN)
    expect(unlocked).not.toContain(FIRST_CARD)
    expect(onUnlock).toHaveBeenCalledTimes(1)
    expect(onUnlock).toHaveBeenCalledWith(unlocked)
  })

  it('does not re-announce a milestone on a repeat run', () => {
    localStorage.setItem(KEY, JSON.stringify([]))
    const onUnlock = vi.fn()

    checkAndNotifyMilestones({ stats: { total_cards: 10 }, profile: {}, userId: USER, onUnlock })
    onUnlock.mockClear()
    const second = checkAndNotifyMilestones({ stats: { total_cards: 10 }, profile: {}, userId: USER, onUnlock })

    expect(second).toEqual([])
    expect(onUnlock).not.toHaveBeenCalled()
  })

  it('persists the unlock before announcing, so a failing notify cannot loop', () => {
    localStorage.setItem(KEY, JSON.stringify([]))
    const onUnlock = vi.fn(() => { throw new Error('insert failed') })

    expect(() => checkAndNotifyMilestones({ stats: { total_cards: 1 }, profile: {}, userId: USER, onUnlock }))
      .toThrow('insert failed')
    expect(getUnlockedSet(USER).has(FIRST_CARD)).toBe(true)
  })

  it('works without an onUnlock handler', () => {
    localStorage.setItem(KEY, JSON.stringify([]))
    const unlocked = checkAndNotifyMilestones({ stats: { total_cards: 1 }, profile: {}, userId: USER })
    expect(unlocked).toContain(FIRST_CARD)
  })

  it('does nothing without a user id', () => {
    const onUnlock = vi.fn()
    expect(checkAndNotifyMilestones({ stats: { total_cards: 10 }, profile: {}, userId: null, onUnlock })).toEqual([])
    expect(onUnlock).not.toHaveBeenCalled()
  })
})
