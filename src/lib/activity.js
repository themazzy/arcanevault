// Global activity counter feeding the app-wide ActivityStatusBadge.
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
