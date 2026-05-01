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

export function checkAndNotifyMilestones({ stats, profile, userId, showToast }) {
  if (!userId || !showToast) return
  const earnedIds = MILESTONES.filter(m => m.check(stats, profile)).map(m => m.id)
  const stored = getUnlockedSet(userId)

  if (stored === null) {
    writeUnlockedSet(userId, new Set(earnedIds))
    return
  }

  const newlyUnlocked = earnedIds.filter(id => !stored.has(id))
  if (newlyUnlocked.length === 0) return

  const next = new Set(stored)
  for (const id of newlyUnlocked) next.add(id)
  writeUnlockedSet(userId, next)

  const byId = new Map(MILESTONES.map(m => [m.id, m]))
  newlyUnlocked.forEach((id, i) => {
    const m = byId.get(id)
    if (!m) return
    setTimeout(() => {
      showToast(`${m.icon} Milestone unlocked — ${m.label}`, { tone: 'success', duration: 4500 })
    }, i * 600)
  })
}
