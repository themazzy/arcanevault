// Tiny performance-span helper for the startup hot paths (see
// performance-upgrade-plan.md Phase 0). Spans land in the Performance
// timeline as `av:<name>` measures and log to console when slow.

const enabled = typeof performance !== 'undefined' && typeof performance.now === 'function'

const LOG_THRESHOLD_MS = 50

export function perfSpan(name) {
  if (!enabled) return () => 0
  const start = performance.now()
  let done = false
  return () => {
    if (done) return 0
    done = true
    const ms = performance.now() - start
    try {
      performance.measure(`av:${name}`, { start, end: start + ms })
    } catch { /* older measure signature — timeline entry is optional */ }
    if (ms >= LOG_THRESHOLD_MS) {
      console.info(`[perf] ${name}: ${Math.round(ms)}ms`)
    }
    return ms
  }
}
