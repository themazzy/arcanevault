// Global activity counter.
//
// Fed the app-wide ActivityStatusBadge until that pill was removed on
// 2026-08-16. The counter itself is kept because trackActivity() wraps real
// Supabase work in DeckBuilder, Folders, Lists and Trading, and is the ready
// hook for any future activity indicator — but nothing currently subscribes,
// so subscribeActivity/getActivityCount have no consumer.
// Pages that write through raw Supabase calls (outside React Query) wrap their
// slow operations in trackActivity() so the badge shows "Syncing…" for them too.

let count = 0
const listeners = new Set()

function emit() {
  for (const listener of listeners) {
    try { listener(count) } catch {}
  }
}

// Increment the counter and return a release function. The release is
// idempotent so a double call (e.g. finally + catch) can't underflow.
export function beginActivity() {
  count++
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    count = Math.max(0, count - 1)
    emit()
  }
}

// Track a promise (or a function returning one). Resolves/rejects transparently;
// the counter is released either way.
export async function trackActivity(work) {
  const end = beginActivity()
  try {
    return await (typeof work === 'function' ? work() : work)
  } finally {
    end()
  }
}

export function subscribeActivity(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getActivityCount() {
  return count
}
