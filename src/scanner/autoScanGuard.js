/**
 * Auto-scan duplicate guard.
 *
 * Auto-scan fires repeatedly at whatever a card in frame will allow, so the
 * card the user just scanned and has not yet picked up gets matched again and
 * again. The guard remembers the name+foil of the last card auto-scan
 * ACCEPTED and swallows those repeats.
 *
 * The signature is deliberately loose (name + foil, no printing): near-identical
 * prints of the same card — basics above all — otherwise re-add themselves every
 * time the match wobbles onto a different printing row.
 *
 * What re-arms the guard is the card LEAVING the frame. A failed scan does not:
 * a card sitting at the edge of MATCH_ACCEPT_CEILING alternates hit / miss /
 * hit on a completely stationary card, so treating a miss as "the card is gone"
 * re-armed the guard between two matches of the same physical card and added it
 * twice (device log 2026-08-08: "Vivi Ornitier" accepted 4× and "Command Tower"
 * 3× from one card each, every repeat separated by a ceiling rejection at 94-99).
 */

export function getAutoScanCardSignature(match, foil = false) {
  return `${String(match?.name || '').trim().toLocaleLowerCase()}|${foil ? 1 : 0}`
}

/** True when this match is the card auto-scan already accepted and kept in frame. */
export function isAutoScanDuplicate({ isAutoScan, signature, remembered }) {
  return !!(isAutoScan && signature && signature === remembered)
}

/**
 * What the guard should remember after a scan attempt.
 * A hit remembers that card; a miss changes nothing (see above); manual scans
 * never touch it, since they are a deliberate per-press user action.
 */
export function nextRememberedSignature({ isAutoScan, signature, remembered }) {
  if (!isAutoScan) return remembered
  return signature || remembered
}

/**
 * Whether an unbroken run of quad-less probes is long enough to call the card
 * gone and let the same name be added again.
 *
 * Needs a real grace period rather than a single quad-less probe: the quick
 * probe finds a quad on only ~40-60% of attempts with a card sitting in frame
 * (see AUTOSCAN_PROBE_STABLE), so short runs of misses are normal and must not
 * release the guard. A physical card swap takes far longer than the grace.
 */
export function shouldReleaseGuard({ quadLostSince, now, graceMs }) {
  return !!quadLostSince && now - quadLostSince >= graceMs
}
