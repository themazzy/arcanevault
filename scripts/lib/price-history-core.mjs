/**
 * Pure helpers for the MTGJSON price-history ingest.
 *
 * Kept out of the script itself so they can be tested without downloading a
 * 143 MB bulk file. Tested in src/lib/priceHistoryCore.test.js.
 */

/**
 * Days of history kept per printing.
 *
 * NOT 90, which is what MTGJSON offers. The window slides daily, so every row
 * is rewritten every run, and Postgres cannot update an array in place — one
 * full rewrite took the table from 72 MB to 96 MB (measured, two consecutive
 * runs). At 90 days the steady state projects to ~140 MB and the database to
 * ~465 MB against a 500 MB cap. 60 days holds a real two-month trend on every
 * card for ~95 MB of steady state and leaves ~80 MB of headroom.
 */
export const HISTORY_DAYS = 60

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
 * The two marketplaces the app can price in, matching PRICE_SOURCES in
 * src/lib/scryfall.js — Cardmarket (EUR) and TCGplayer (USD).
 *
 * MTGJSON also carries cardkingdom and manapool, and a buylist for each
 * provider. None of those are stored: nothing in the app prices from them, and
 * every extra series is ~24 MB of a 500 MB database.
 *
 * TCGplayer additionally reports an `etched` finish on ~1,200 printings. It is
 * skipped for the same reason — PRICE_SOURCES has no etched entry, so there is
 * no surface that could display it.
 */
export const CURRENCIES = [
  { key: 'eur', provider: 'cardmarket', column: 'prices_eur', foilColumn: 'prices_foil_eur' },
  { key: 'usd', provider: 'tcgplayer', column: 'prices_usd', foilColumn: 'prices_usd_foil' },
]

/** True when an entry has any retail block we care about. */
export function hasStorableRetail(priceEntry) {
  return CURRENCIES.some(c => priceEntry?.paper?.[c.provider]?.retail)
}

/** The blocks worth retaining while streaming, keyed by currency. */
export function retailBlocks(priceEntry) {
  const out = {}
  for (const c of CURRENCIES) {
    const retail = priceEntry?.paper?.[c.provider]?.retail
    if (retail) out[c.key] = retail
  }
  return out
}

/**
 * Fold one printing's retail blocks into an accumulator keyed by Scryfall id.
 *
 * Merging is required, not a nicety: the uuid -> scryfallId mapping is
 * many-to-one, because MTGJSON issues separate uuids for variants (etched and
 * foil above all) that Scryfall keeps as one id with several finishes. Left
 * unmerged a batch carries the same scryfall_id twice and Postgres rejects the
 * whole statement with "ON CONFLICT DO UPDATE command cannot affect row a
 * second time". Last-one-wins would not do either — the variants carry
 * DIFFERENT coverage, typically one the normal series and the other the foil,
 * so keeping one drops half the card's history.
 *
 * The ingest keeps only these blocks while streaming. Retaining whole parsed
 * entries instead ran the job out of heap: each also carries cardkingdom,
 * manapool and every provider's buylist.
 */
export function mergeRetailBlockInto(acc, blocks) {
  if (!blocks) return acc
  const target = acc || {}
  for (const c of CURRENCIES) {
    const retail = blocks[c.key]
    if (!retail) continue
    const bucket = target[c.key] || (target[c.key] = { normal: {}, foil: {} })
    for (const finish of ['normal', 'foil']) {
      const branch = retail[finish]
      if (!branch) continue
      for (const [iso, price] of Object.entries(branch)) {
        // A day already claimed by another variant keeps its value; they are
        // the same card on the same day, so this only decides ties.
        if (bucket[finish][iso] == null) bucket[finish][iso] = price
      }
    }
  }
  return Object.keys(target).length ? target : acc
}

/** Row builder for an accumulator produced by mergeRetailBlockInto. */
export function rowFromAccumulator(scryfallId, acc, startDate, days = HISTORY_DAYS) {
  if (!acc) return null
  const row = { scryfall_id: scryfallId, start_date: startDate }
  let any = false
  for (const c of CURRENCIES) {
    const normal = seriesFromDateMap(acc[c.key]?.normal, startDate, days)
    const foil = seriesFromDateMap(acc[c.key]?.foil, startDate, days)
    row[c.column] = normal
    row[c.foilColumn] = foil
    if (normal || foil) any = true
  }
  return any ? row : null
}

/**
 * Slots no printing in the whole file has a price for.
 *
 * These are MTGJSON publishing outages, not market events: measured 2026-09-13,
 * five days in the 60-day window had a price for ZERO of 20,000 sampled cards
 * (2026-08-06, 08-29, and the consecutive run 08-31 / 09-01 / 09-02). No
 * weekend pattern — Thu, Sat, Mon, Tue, Wed — so they are failed builds.
 *
 * The distinction matters because the two cases deserve opposite treatment. A
 * day THIS card has no price for means nobody listed it, and the chart should
 * show a gap. A day NOBODY has a price for means the feed was down while the
 * market carried on, and a gap there is an artefact of our plumbing.
 */
export function globallyMissingSlots(seriesList, days = HISTORY_DAYS) {
  const covered = new Array(days).fill(false)
  for (const series of seriesList) {
    if (!series) continue
    for (let i = 0; i < days; i++) {
      if (series[i] != null) covered[i] = true
    }
  }
  const missing = new Set()
  for (let i = 0; i < days; i++) if (!covered[i]) missing.add(i)
  return missing
}

/**
 * Interpolate across the given slots only, in place.
 *
 * Applied solely to slots `globallyMissingSlots` identified, so a card-specific
 * absence is never invented over. An unbounded run (leading or trailing) is
 * left alone — there is nothing to interpolate between.
 */
export function fillSlots(series, slots) {
  if (!series || !slots?.size) return series
  for (let i = 0; i < series.length; i++) {
    if (series[i] != null || !slots.has(i)) continue

    let end = i
    while (end < series.length && series[end] == null && slots.has(end)) end++
    const before = i > 0 ? series[i - 1] : null
    const after = end < series.length ? series[end] : null

    if (before != null && after != null) {
      const span = end - i + 1
      for (let j = i; j < end; j++) {
        const t = (j - i + 1) / span
        series[j] = Math.round((before + (after - before) * t) * 100) / 100
      }
    }
    i = end - 1
  }
  return series
}

/** Newest date present in an accumulator. */
export function latestDateInAccumulator(acc) {
  let latest = null
  for (const c of CURRENCIES) {
    for (const finish of ['normal', 'foil']) {
      for (const iso of Object.keys(acc?.[c.key]?.[finish] || {})) {
        if (!latest || iso > latest) latest = iso
      }
    }
  }
  return latest
}
