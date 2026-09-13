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

/** Fetches the stored series for one printing. Null when we have none. */
export async function fetchPriceHistory(scryfallId) {
  if (!scryfallId) return null
  const { data, error } = await sb
    .from('card_price_history')
    .select('start_date, prices_eur, prices_foil_eur')
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
export function expandSeries(row, foil = false) {
  const prices = foil ? row?.prices_foil_eur : row?.prices_eur
  if (!row?.start_date || !Array.isArray(prices) || !prices.length) return []
  const start = Date.parse(`${row.start_date}T00:00:00Z`)
  return prices.map((price, i) => ({
    date: new Date(start + i * DAY_MS).toISOString().slice(0, 10),
    price: typeof price === 'number' && Number.isFinite(price) ? price : null,
  }))
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
