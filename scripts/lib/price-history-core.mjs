/**
 * Pure helpers for the MTGJSON price-history ingest.
 *
 * Kept out of the script itself so they can be tested without downloading a
 * 143 MB bulk file. Tested in src/lib/priceHistoryCore.test.js.
 */

/** Days the chart keeps. MTGJSON's window is ~86-90; this is the ceiling. */
export const HISTORY_DAYS = 90

const DAY_MS = 86400000

/** `YYYY-MM-DD` in UTC. Local-date arithmetic repeats a day across a DST
 *  boundary, which is exactly the bug the traffic charts hit. */
export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

export function dayMs(iso) {
  return Date.parse(`${iso}T00:00:00Z`)
}

/** Inclusive whole-day difference between two `YYYY-MM-DD` strings. */
export function daysBetween(fromIso, toIso) {
  return Math.round((dayMs(toIso) - dayMs(fromIso)) / DAY_MS)
}

/**
 * Turn MTGJSON's sparse `{ "2026-09-13": 4.02 }` map into a contiguous array
 * anchored at `startDate`.
 *
 * A day the source has no price for becomes `null`, NOT a carried-forward or
 * interpolated value: the chart has to draw a gap there. Inventing a point
 * would turn "Cardmarket had no listing" into a flat line that looks like real
 * market data, and a spike alert would then fire off a number nobody quoted.
 *
 * Returns null when there is nothing to store, so the caller can omit the
 * column rather than write an array of nulls.
 */
export function seriesFromDateMap(dateMap, startDate, days = HISTORY_DAYS) {
  if (!dateMap) return null
  const out = new Array(days).fill(null)
  let any = false

  for (const [iso, price] of Object.entries(dateMap)) {
    const idx = daysBetween(startDate, iso)
    if (idx < 0 || idx >= days) continue
    const n = Number(price)
    if (!Number.isFinite(n) || n <= 0) continue
    out[idx] = Math.round(n * 100) / 100
    any = true
  }
  return any ? out : null
}

/**
 * The window the whole table shares: `days` back from the newest date the
 * source published, so every row is index-aligned to the same origin and the
 * client needs one start_date rather than one per card.
 */
export function windowStart(latestIso, days = HISTORY_DAYS) {
  return isoDay(dayMs(latestIso) - (days - 1) * DAY_MS)
}

/**
 * Build the row for one printing, or null when the card has no EUR price at
 * all. `paper.cardmarket.retail` is the only branch read: it is EUR and it is
 * the same Cardmarket trend number already stored in card_prices, verified
 * identical to the cent on 2026-09-13.
 */
export function priceHistoryRow(scryfallId, priceEntry, startDate, days = HISTORY_DAYS) {
  const retail = priceEntry?.paper?.cardmarket?.retail
  if (!retail) return null

  const normal = seriesFromDateMap(retail.normal, startDate, days)
  const foil = seriesFromDateMap(retail.foil, startDate, days)
  if (!normal && !foil) return null

  return {
    scryfall_id: scryfallId,
    start_date: startDate,
    prices_eur: normal,
    prices_foil_eur: foil,
  }
}

/** Newest date present anywhere in a card's cardmarket retail block. */
export function latestDateIn(priceEntry) {
  const retail = priceEntry?.paper?.cardmarket?.retail
  if (!retail) return null
  let latest = null
  for (const branch of [retail.normal, retail.foil]) {
    if (!branch) continue
    for (const iso of Object.keys(branch)) {
      if (!latest || iso > latest) latest = iso
    }
  }
  return latest
}
