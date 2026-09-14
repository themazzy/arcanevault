import { sb } from './supabase'
import { historySource } from './priceHistory'

/**
 * Price-move alerts.
 *
 * The expensive half is not done here and not done per user: the ingest job
 * writes `card_price_moves` once for the whole catalogue at a floor looser than
 * any sane setting (>=10% and >=0.50). This module fetches that short list —
 * tens to low hundreds of rows — and intersects it with the collection the
 * client already holds, so a user's own thresholds are a local filter and
 * changing them costs nothing.
 *
 * Everything below the fetch is pure, and tested in src/lib/priceAlerts.test.js.
 */

export const ALERT_DEFAULTS = {
  price_alerts_enabled: true,
  // Measured 2026-09-14 across 87,163 priced printings: on one day, 6,751
  // printings moved >=10%, but only 9 moved >=20% AND >=1 unit. The absolute
  // gate is what makes this readable rather than a feed.
  price_alert_pct: 20,
  price_alert_min_value: 1,
  price_alert_days: 7,
}

export const ALERT_WINDOWS = [
  { days: 1, label: 'Today' },
  { days: 3, label: 'Last 3 days' },
  { days: 7, label: 'Last 7 days' },
]

/** `YYYY-MM-DD`, `days` before today, in UTC to match how moves are dated. */
export function windowCutoff(days, now = new Date()) {
  return new Date(now.getTime() - (Math.max(1, days) - 1) * 86400000)
    .toISOString().slice(0, 10)
}

/**
 * Fetches movers on or after `cutoff`.
 *
 * Deliberately unfiltered by card: the whole list is small, and asking for
 * "movers among these 17,000 scryfall_ids" would be a URL no server wants and a
 * query that scales with the collection instead of with the news.
 */
export async function fetchRecentMoves(cutoff) {
  const { data, error } = await sb
    .from('card_price_moves')
    .select('scryfall_id, move_date, currency, finish, price_from, price_to, delta, pct')
    .gte('move_date', cutoff)
    .order('move_date', { ascending: false })
  if (error) throw error
  return data || []
}

/**
 * Index a collection by the identity a move is keyed on.
 *
 * Finish matters: a foil copy is a different price series, and alerting a foil
 * owner about the non-foil move would be telling them about a card they do not
 * have. Quantity is summed so the panel can show what the move is worth to
 * someone holding four of them.
 */
export function indexOwned(cards) {
  const byKey = new Map()
  for (const card of cards || []) {
    const sid = card?.scryfall_id
    if (!sid) continue
    const key = `${sid}:${card.foil ? 'foil' : 'normal'}`
    const entry = byKey.get(key)
    const qty = Number(card.qty) || 1
    if (entry) {
      entry.qty += qty
    } else {
      byKey.set(key, { scryfall_id: sid, finish: card.foil ? 'foil' : 'normal', qty, name: card.name })
    }
  }
  return byKey
}

/**
 * Movers the user actually owns, above their own thresholds, in their own
 * currency.
 *
 * Only the currency matching their price source is considered — a Cardmarket
 * user has no use for a dollar move, and showing both would double every alert.
 */
export function alertsFor(moves, ownedByKey, settings = {}, priceSourceId = 'cardmarket_trend') {
  const {
    price_alert_pct: minPct = ALERT_DEFAULTS.price_alert_pct,
    price_alert_min_value: minValue = ALERT_DEFAULTS.price_alert_min_value,
  } = settings
  const currency = historySource(priceSourceId).currency

  const out = []
  for (const move of moves || []) {
    if (move.currency !== currency) continue
    if (Math.abs(move.pct) < minPct) continue
    if (Math.abs(move.delta) < minValue) continue

    const owned = ownedByKey.get(`${move.scryfall_id}:${move.finish}`)
    if (!owned) continue

    out.push({
      ...move,
      qty: owned.qty,
      name: owned.name,
      // What the move did to this holding, which is the number that matters to
      // someone with four copies.
      holdingDelta: move.delta * owned.qty,
      key: `price:${move.scryfall_id}:${move.move_date}:${move.finish}`,
    })
  }

  // Biggest effect on the collection first, not biggest percentage: a 40% move
  // on a bulk rare matters less than 12% on a staple you own four of.
  return out.sort((a, b) => Math.abs(b.holdingDelta) - Math.abs(a.holdingDelta))
}

/**
 * Parses a notification key back into the move it refers to.
 *
 * The notifications table has no text column — content is derived client-side
 * from the type and the id — so the key has to carry enough to find the move
 * again. Returns null for anything malformed rather than throwing, since a
 * stale key from an older format must not break the whole bell.
 */
export function parseAlertKey(key) {
  const parts = String(key || '').split(':')
  if (parts.length !== 4 || parts[0] !== 'price') return null
  const [, scryfallId, moveDate, finish] = parts
  if (!scryfallId || !moveDate || (finish !== 'normal' && finish !== 'foil')) return null
  return { scryfall_id: scryfallId, move_date: moveDate, finish }
}

/**
 * Fills in what the bell needs to render alert rows: the move itself and the
 * card's name.
 *
 * Two small queries over at most a handful of ids, run only when the bell is
 * opened. Deliberately not denormalised into the notification row — that would
 * mean a text column on a table shared with likes, follows and comments, and a
 * card renamed or repriced afterwards would show stale text forever.
 */
export async function fetchAlertDetails(keys) {
  const parsed = (keys || []).map(parseAlertKey).filter(Boolean)
  if (!parsed.length) return new Map()

  const ids = [...new Set(parsed.map(p => p.scryfall_id))]
  const [movesRes, printsRes] = await Promise.all([
    sb.from('card_price_moves')
      .select('scryfall_id, move_date, currency, finish, price_from, price_to, delta, pct')
      .in('scryfall_id', ids),
    sb.from('card_prints').select('scryfall_id, name').in('scryfall_id', ids),
  ])
  if (movesRes.error) throw movesRes.error
  if (printsRes.error) throw printsRes.error

  const names = new Map((printsRes.data || []).map(r => [r.scryfall_id, r.name]))
  const byKey = new Map()
  for (const move of movesRes.data || []) {
    byKey.set(`price:${move.scryfall_id}:${move.move_date}:${move.finish}`, {
      ...move,
      name: names.get(move.scryfall_id) || null,
    })
  }
  return byKey
}
