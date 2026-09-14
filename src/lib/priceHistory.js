import { sb } from './supabase'

/**
 * Card price history — reads the rolling window ingested from MTGJSON into
 * card_price_history (see scripts/sync-price-history.mjs).
 *
 * The table stores one row per printing with a fixed-origin array, so a point's
 * date is derived from its index rather than stored per point. Everything that
 * turns that array into something drawable lives here as pure functions, tested
 * in src/lib/priceHistory.test.js.
 */

const DAY_MS = 86400000

/**
 * Which stored columns a price source reads, and how to render it.
 *
 * Mirrors PRICE_SOURCES in src/lib/scryfall.js. The chart has to follow the
 * user's setting: it previously drew Cardmarket EUR unconditionally, so someone
 * pricing in TCGplayer read a chart in a currency they do not use, ending on a
 * number that disagreed with every other figure on the page.
 */
export const HISTORY_SOURCES = {
  cardmarket_trend: { column: 'prices_eur', foilColumn: 'prices_foil_eur', symbol: '€', label: 'Cardmarket', currency: 'eur' },
  tcgplayer_market: { column: 'prices_usd', foilColumn: 'prices_usd_foil', symbol: '$', label: 'TCGplayer', currency: 'usd' },
}

export function historySource(priceSourceId) {
  return HISTORY_SOURCES[priceSourceId] || HISTORY_SOURCES.cardmarket_trend
}

/** Fetches the stored series for one printing. Null when we have none. */
export async function fetchPriceHistory(scryfallId) {
  if (!scryfallId) return null
  const { data, error } = await sb
    .from('card_price_history')
    .select('start_date, prices_eur, prices_foil_eur, prices_usd, prices_usd_foil')
    .eq('scryfall_id', scryfallId)
    .maybeSingle()
  if (error) throw error
  return data || null
}

/**
 * Expand the stored array into dated points.
 *
 * A null slot stays null rather than being dropped, because the chart has to
 * draw a GAP there. Dropping it would slide the following points left and turn
 * a week Cardmarket had no listing into a continuous line — the same failure as
 * the traffic charts, where a categorical axis silently closed ranks over
 * missing days and three scattered points read as a growth trend.
 */
export function expandSeries(row, foil = false, priceSourceId = 'cardmarket_trend') {
  const src = historySource(priceSourceId)
  const prices = foil ? row?.[src.foilColumn] : row?.[src.column]
  if (!row?.start_date || !Array.isArray(prices) || !prices.length) return []
  const start = Date.parse(`${row.start_date}T00:00:00Z`)
  return prices.map((price, i) => ({
    index: i,
    date: new Date(start + i * DAY_MS).toISOString().slice(0, 10),
    price: typeof price === 'number' && Number.isFinite(price) ? price : null,
  }))
}

/**
 * Longest run of missing days that gets filled in rather than drawn as a break.
 *
 * A one- or two-day hole in a daily series is Cardmarket not reporting, not the
 * card ceasing to have a value — and breaking the line on every one of them
 * shattered sparse series (foil above all) into confetti that read as a broken
 * chart rather than as missing data. Anything longer stays a real gap, because
 * a week without a listing IS the information.
 */
export const MAX_BRIDGED_GAP = 2

/**
 * Fill short holes by linear interpolation, leaving longer ones null.
 *
 * Interpolated points are marked `estimated` so nothing downstream mistakes
 * them for quoted prices: the chart may draw through them, but a spike alert
 * must never fire on a number nobody published.
 */
export function bridgeShortGaps(points, maxGap = MAX_BRIDGED_GAP) {
  const out = points.map(p => ({ ...p }))
  let runStart = -1

  for (let i = 0; i < out.length; i++) {
    if (out[i].price == null) {
      if (runStart === -1) runStart = i
      continue
    }
    const gap = runStart === -1 ? 0 : i - runStart
    // Only an interior gap is bridgeable — a leading run has no left anchor.
    if (gap > 0 && gap <= maxGap && runStart > 0) {
      const before = out[runStart - 1].price
      const after = out[i].price
      for (let j = runStart; j < i; j++) {
        const t = (j - runStart + 1) / (gap + 1)
        out[j].price = Math.round((before + (after - before) * t) * 100) / 100
        out[j].estimated = true
      }
    }
    runStart = -1
  }
  return out
}

/**
 * Axis values a person would actually choose: a 1 / 2 / 2.5 / 5 / 10 step at the
 * right magnitude, rather than the raw padded bounds. The first version printed
 * the bounds directly and produced ticks like 56.06 / 64.44 / 72.81.
 */
export function niceTicks(lo, hi, target = 3) {
  if (!(Number.isFinite(lo) && Number.isFinite(hi)) || hi <= lo) return []
  const raw = (hi - lo) / Math.max(1, target - 1)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag

  const ticks = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    ticks.push(Math.round(v * 100) / 100)
  }
  return ticks
}

/**
 * Split into runs of consecutive priced days.
 *
 * One `<path>` per segment is what actually renders a gap: a single path
 * through every point would bridge the missing days with a straight line that
 * looks like real, slowly-moving market data.
 */
export function toSegments(points) {
  const segments = []
  let current = []
  for (const p of points) {
    if (p.price == null) {
      if (current.length) { segments.push(current); current = [] }
      continue
    }
    current.push(p)
  }
  if (current.length) segments.push(current)
  return segments
}

/**
 * Headline numbers for the chart. `change` compares the newest priced day with
 * the oldest priced day in the window — not with slot 0, which may be a gap.
 */
export function summarize(points) {
  const priced = points.filter(p => p.price != null)
  if (!priced.length) return null
  const values = priced.map(p => p.price)
  const first = priced[0]
  const last = priced[priced.length - 1]
  const min = Math.min(...values)
  const max = Math.max(...values)
  return {
    first, last, min, max,
    count: priced.length,
    change: last.price - first.price,
    changePct: first.price > 0 ? (last.price - first.price) / first.price * 100 : null,
  }
}

/**
 * Y-axis bounds.
 *
 * Deliberately NOT zero-based: card prices sit far from zero and a zero floor
 * flattens every real move into a straight line. A flat series still gets a
 * band so it renders as a centred line rather than dividing by zero.
 */
export function priceBounds(min, max, padding = 0.12) {
  if (!(Number.isFinite(min) && Number.isFinite(max))) return null
  if (min === max) {
    const pad = Math.max(min * 0.05, 0.01)
    return { lo: min - pad, hi: max + pad }
  }
  const pad = (max - min) * padding
  return { lo: Math.max(0, min - pad), hi: max + pad }
}
