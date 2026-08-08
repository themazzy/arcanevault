/**
 * scanLog.js — in-app ring buffer of per-scan diagnostic lines
 *
 * CardScanner already emits one `[scan]` line per attempt to the console with a
 * full per-stage breakdown (capture / detect / warp / hash / match, frame
 * summaries, source, fusion and rescue costs). Reading those off a phone
 * otherwise means USB debugging and chrome://inspect, which is enough friction
 * that slow-scan reports arrive as "it felt slow" rather than as numbers.
 *
 * This keeps the last SCAN_LOG_LIMIT lines in memory so an admin can copy them
 * out of the scanner's own settings panel. Memory only, deliberately: these
 * lines describe scanning behaviour, not user data, and there is no reason to
 * persist or transmit them.
 */

export const SCAN_LOG_LIMIT = 40

const entries = []
const listeners = new Set()

function emit() {
  for (const fn of listeners) {
    try { fn(entries) } catch { /* a broken listener must not break scanning */ }
  }
}

/**
 * Record one scan line. Called from the same place as the console.info so the
 * two can never drift apart.
 * @param {string} line — the formatted `[scan] …` text
 */
export function pushScanLog(line) {
  entries.push({ at: Date.now(), line })
  if (entries.length > SCAN_LOG_LIMIT) entries.splice(0, entries.length - SCAN_LOG_LIMIT)
  emit()
}

export function getScanLog() {
  return entries
}

export function clearScanLog() {
  entries.length = 0
  emit()
}

/** Subscribe to changes; returns an unsubscribe function. */
export function subscribeScanLog(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Render the buffer as plain text for copying. Timestamps are wall-clock local
 * time so gaps between scans (the user lining up the next card) stay visible —
 * a scan that took 900 ms reads very differently from one that started 900 ms
 * after the previous finished.
 */
export function formatScanLog() {
  if (!entries.length) return ''
  const stamp = at => new Date(at).toTimeString().slice(0, 8)
  const header = [
    `# DeckLoom scan log — ${entries.length} entries`,
    `# ${new Date().toISOString()} · ${navigator.userAgent}`,
    '',
  ].join('\n')
  return header + entries.map(e => `${stamp(e.at)} ${e.line}`).join('\n')
}
