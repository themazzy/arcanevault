import { MILESTONES } from './milestones'

const KEY_PREFIX = 'arcanevault_unlocked_milestones_'

function storageKey(userId) {
  return `${KEY_PREFIX}${userId || 'anon'}`
}

export function getUnlockedSet(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function writeUnlockedSet(userId, set) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify([...set]))
  } catch {}
}

// Detects newly-earned milestones and hands their ids to `onUnlock`.
//
// Unlocks used to fire a toast each (staggered 600ms apart), which meant a
// first sync or a big import buried the screen in popups. They go to the
// notification bell now — `onUnlock` writes the rows; this function only
// decides what's new.
//
// The localStorage set is the per-device "already announced" guard so a reload
// doesn't re-announce; the (user_id, milestone_id) unique index is what stops
// two devices from double-notifying. It's written before onUnlock runs so a
// failed insert can't produce a toast-every-load loop — the bell is a
// nice-to-have, the profile grid is the real record of what's earned.
export function checkAndNotifyMilestones({ stats, profile, userId, onUnlock }) {
  if (!userId) return []
  const earnedIds = MILESTONES.filter(m => m.check(stats, profile)).map(m => m.id)
  const stored = getUnlockedSet(userId)

  // First run on this device: adopt whatever is already earned silently,
  // otherwise every existing milestone would announce itself at once.
  if (stored === null) {
    writeUnlockedSet(userId, new Set(earnedIds))
    return []
  }

  const newlyUnlocked = earnedIds.filter(id => !stored.has(id))
  if (newlyUnlocked.length === 0) return []

  const next = new Set(stored)
  for (const id of newlyUnlocked) next.add(id)
  writeUnlockedSet(userId, next)

  onUnlock?.(newlyUnlocked)
  return newlyUnlocked
}
