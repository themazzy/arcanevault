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

/**
 * A day with no price, in the integer-cent series below.
 *
 * A sentinel rather than `null` because the series are Int32Arrays, which
 * cannot hold one — see `newSeries` for why they are typed at all. Negative is
 * safe: `toCents` rejects zero and everything below it, so no real price can
 * collide with it.
 */
export const NO_PRICE = -1

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

/**
 * One stored column per marketplace and finish, each naming the exact MTGJSON
 * path it reads. Enumerating the paths here is what keeps `foldEntryInto` from
 * ever touching the rest of an entry: every other provider, buylist and finish
 * is unreachable rather than merely discarded afterwards.
 */
export const SERIES = CURRENCIES.flatMap(c => [
  { column: c.column, provider: c.provider, finish: 'normal' },
  { column: c.foilColumn, provider: c.provider, finish: 'foil' },
])

export const SERIES_COLUMNS = SERIES.map(s => s.column)

/** column -> currency key, for anything that reports a series to the client. */
export const SERIES_CURRENCY = Object.fromEntries(
  CURRENCIES.flatMap(c => [[c.column, c.key], [c.foilColumn, c.key]]),
)

// ── Staging window ──────────────────────────────────────────────────────────
// Prices are folded into fixed-length arrays AS THEY STREAM, which needs a day
// zero before the newest published date is known. MTGJSON's own `meta.date` is
// that anchor, with enough slack either side that the real window cannot fall
// outside it — and the script asserts that it did not, so a wrong anchor fails
// the run loudly instead of silently truncating history.
//
// Why fold at all, rather than retain the date maps and convert at the end:
// each `{ "2026-09-13": 4.02 }` map costs ~6 KB in V8 (dictionary properties, a
// freshly parsed key string per day, a boxed double per value) and there are
// four per printing across ~101k printings. That is ~2.4 GB of staging for what
// fits in ~2 KB of Int32Array per card, and it ran the job out of heap twice:
// first retaining whole entries, then — once a second marketplace was added —
// retaining just the two blocks it needed.

/** Days of slack before the build date. Tolerates a badly stale feed. */
export const STAGING_LAG = 120
/** Days of slack after it. A build dated ahead of its own prices is not
 *  something we have seen, but allowing for it costs one week of array. */
export const STAGING_LEAD = 7
export const STAGING_SPAN = STAGING_LAG + STAGING_LEAD + 1

/** Day zero of the staging arrays, from the bulk file's own build date. */
export function stagingBase(buildDate) {
  return isoDay(dayMs(buildDate) - STAGING_LAG * DAY_MS)
}

/**
 * A staging or output series: integer cents, `NO_PRICE` for a day with no
 * price.
 *
 * Int32Array rather than a plain array because a slot of a JS array holding
 * doubles costs ~8 bytes of pointer plus ~16 of boxed number, against a flat 4.
 * Cents rather than floats because they are exact — the rounding every price
 * needs anyway happens once, at ingest, instead of again on every
 * interpolation.
 */
export function newSeries(span) {
  return new Int32Array(span).fill(NO_PRICE)
}

/** A price as whole cents, or `NO_PRICE` if it is not one. */
export function toCents(price) {
  const n = Number(price)
  if (!Number.isFinite(n) || n <= 0) return NO_PRICE
  return Math.round(n * 100)
}

/**
 * Fold one MTGJSON price entry into a dense accumulator.
 *
 * Returns the accumulator, creating it — and each series inside it — only when
 * there is something to put there, so a card priced by one marketplace never
 * allocates the other's arrays.
 *
 * `stats` collects the two things the caller cannot recover afterwards: the
 * newest date anywhere in the file, which sets the shared window, and how many
 * dates fell outside the staging span, which is how a wrong anchor announces
 * itself.
 *
 * A day already holding a price keeps it. Within one entry each column is
 * written once, so that only decides ties between variants merged later.
 */
export function foldEntryInto(acc, priceEntry, baseDate, span = STAGING_SPAN, stats = null) {
  for (const s of SERIES) {
    const branch = priceEntry?.paper?.[s.provider]?.retail?.[s.finish]
    if (!branch) continue

    for (const iso of Object.keys(branch)) {
      const cents = toCents(branch[iso])
      if (cents === NO_PRICE) continue
      if (stats && (!stats.latest || iso > stats.latest)) stats.latest = iso

      const idx = daysBetween(baseDate, iso)
      if (idx < 0 || idx >= span) {
        if (stats) stats.outOfRange++
        continue
      }
      if (!acc) acc = {}
      const series = acc[s.column] || (acc[s.column] = newSeries(span))
      if (series[idx] === NO_PRICE) series[idx] = cents
    }
  }
  return acc
}

/**
 * Fold one accumulator into another, in place, the first value for a day
 * winning.
 *
 * Merging is required, not a nicety: the uuid -> scryfallId mapping is
 * many-to-one, because MTGJSON issues separate uuids for variants (etched and
 * foil above all) that Scryfall keeps as one id with several finishes. Left
 * unmerged a batch carries the same scryfall_id twice and Postgres rejects the
 * whole statement with "ON CONFLICT DO UPDATE command cannot affect row a
 * second time". Last-one-wins would not do either — the variants carry
 * DIFFERENT coverage, typically one the normal series and the other the foil,
 * so keeping one drops half the card's history.
 */
export function mergeAccumulators(target, source) {
  if (!source) return target
  if (!target) return source

  for (const column of SERIES_COLUMNS) {
    const from = source[column]
    if (!from) continue
    const into = target[column]
    if (!into) { target[column] = from; continue }
    for (let i = 0; i < into.length; i++) {
      if (into[i] === NO_PRICE) into[i] = from[i]
    }
  }
  return target
}

/**
 * Cut the shared `days`-long window out of a staged accumulator.
 *
 * The window is copied, not a subarray view: a view would keep the whole
 * staging buffer alive behind every row, which defeats the point of narrowing.
 *
 * Returns null when no marketplace priced the card inside the window, so the
 * caller can skip the row rather than write one that is entirely nulls.
 */
export function rowFromAccumulator(scryfallId, acc, baseDate, startDate, days = HISTORY_DAYS) {
  if (!acc) return null
  const offset = daysBetween(baseDate, startDate)
  const row = { scryfall_id: scryfallId, start_date: startDate }
  let any = false

  for (const column of SERIES_COLUMNS) {
    const staged = acc[column]
    let series = null

    if (staged && offset >= 0) {
      const end = Math.min(offset + days, staged.length)
      const window = newSeries(days)
      if (end > offset) window.set(staged.subarray(offset, end), 0)
      for (let i = 0; i < days; i++) {
        if (window[i] !== NO_PRICE) { series = window; break }
      }
    }
    row[column] = series
    if (series) any = true
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
 * day THIS card has no price for means nobody listed it, and no alert should
 * compare against it. A day NOBODY has a price for means the feed was down
 * while the market carried on, and treating that as a price move would fire an
 * alert off our own plumbing — see the `filled` guard in priceMovesFor.
 */
export function globallyMissingSlots(seriesList, days = HISTORY_DAYS) {
  const covered = new Uint8Array(days)
  for (const series of seriesList) {
    if (!series) continue
    for (let i = 0; i < days; i++) {
      if (series[i] !== NO_PRICE) covered[i] = 1
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
    if (series[i] !== NO_PRICE || !slots.has(i)) continue

    let end = i
    while (end < series.length && series[end] === NO_PRICE && slots.has(end)) end++
    const before = i > 0 ? series[i - 1] : NO_PRICE
    const after = end < series.length ? series[end] : NO_PRICE

    if (before !== NO_PRICE && after !== NO_PRICE) {
      const span = end - i + 1
      for (let j = i; j < end; j++) {
        series[j] = Math.round(before + (after - before) * ((j - i + 1) / span))
      }
    }
    i = end - 1
  }
  return series
}

// ── Daily movers ────────────────────────────────────────────────────────────

/**
 * Floors for what counts as a move worth storing.
 *
 * Deliberately looser than any sane alert setting, so a user tightening their
 * own threshold is a filter over rows we already have rather than a reason to
 * recompute anything. MIN_MOVE_CENTS is the load-bearing half: measured
 * 2026-09-14 over 87,163 priced printings, 6,751 moved >=10% in a single day
 * but only 60 also moved >=0.50 — the rest are penny cards going 2c -> 3c,
 * which is a 50% move and no information at all.
 */
export const MIN_MOVE_PCT = 10
export const MIN_MOVE_CENTS = 50

/**
 * Day-over-day movers for one printing, across every stored series.
 *
 * `filled` maps a column to the slots this run interpolated across a source
 * outage, and a move touching either end of one is skipped outright. That is
 * the entire reason those slots are tracked: an alert must never fire on a
 * price nobody published.
 *
 * Operates directly on the staged cents arrays, so it never re-parses anything.
 */
export function priceMovesFor(row, filled, moveDate) {
  const moves = []

  for (const { column, finish } of SERIES) {
    const series = row[column]
    if (!series || series.length < 2) continue

    const last = series.length - 1
    const prev = last - 1
    const filledSlots = filled?.[column]
    if (filledSlots?.has(last) || filledSlots?.has(prev)) continue

    const to = series[last]
    const from = series[prev]
    if (to === NO_PRICE || from === NO_PRICE || from <= 0) continue

    const deltaCents = to - from
    if (Math.abs(deltaCents) < MIN_MOVE_CENTS) continue
    const pct = (deltaCents / from) * 100
    if (Math.abs(pct) < MIN_MOVE_PCT) continue

    moves.push({
      scryfall_id: row.scryfall_id,
      move_date: moveDate,
      currency: SERIES_CURRENCY[column],
      finish,
      price_from: from / 100,
      price_to: to / 100,
      delta: deltaCents / 100,
      pct: Math.round(pct * 10) / 10,
    })
  }
  return moves
}
