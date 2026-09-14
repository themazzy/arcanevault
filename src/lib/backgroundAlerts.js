import { isNativeApp } from './nativeAuth'
import { historySource } from './priceHistory'
import { ALERT_DEFAULTS } from './priceAlerts'

/**
 * Feeds the background price-alert runner.
 *
 * public/runners/price-alerts.js executes in its own JS context with no DOM, no
 * IndexedDB and no access to app code — only a key-value store. So everything
 * it needs is mirrored here while the app is open, and the runner then works
 * for days without the app being launched.
 *
 * It reads card_price_moves with the anon key. That is fine and deliberate:
 * the table is public reference data, so there is no session to keep alive in a
 * context that might not run for a week.
 */

const KV_KEYS = [
  'bgUrl', 'bgKey', 'bgCurrency', 'bgSymbol',
  'bgMinPct', 'bgMinValue', 'bgDays', 'bgWatch',
]

let pluginPromise = null

function loadRunner() {
  if (!pluginPromise) {
    pluginPromise = import('@capacitor/background-runner')
      .then(m => m.BackgroundRunner)
      .catch(() => null)
  }
  return pluginPromise
}

/**
 * The identity a move is matched on, truncated.
 *
 * MUST match watchKey() in the runner — they cannot share code across the
 * context boundary, so this pairing is load-bearing and a test pins the format.
 *
 * 16 hex characters is 64 bits. Across ~4k watched printings a collision is
 * vanishingly unlikely, and the saving is real: the full ids for this
 * collection would be ~62 KB of SharedPreferences rather than ~29 KB.
 */
export function watchKey(scryfallId, finish) {
  return String(scryfallId).slice(0, 16) + (finish === 'foil' ? 'f' : 'n')
}

/**
 * Which owned printings are worth mirroring.
 *
 * Not the whole collection: this one has 12,359 distinct printings, of which
 * 3,651 are worth 0.50 or more (measured 2026-09-14). A card essentially has to
 * be worth about the money threshold to move by it — going from 0.20 to 1.20 is
 * a 500% jump — so half the threshold is a generous floor that still cuts the
 * list by about 70%.
 *
 * `priceOf` is injected so this stays pure and testable.
 */
export function buildWatchlist(cards, minValue, priceOf) {
  const floor = Math.max(0, (Number(minValue) || ALERT_DEFAULTS.price_alert_min_value) / 2)
  const keys = new Set()

  for (const card of cards || []) {
    const sid = card?.scryfall_id
    if (!sid) continue
    const price = priceOf(card)
    if (!(price >= floor)) continue
    keys.add(watchKey(sid, card.foil ? 'foil' : 'normal'))
  }
  return [...keys]
}

/**
 * Mirrors the current settings and watchlist into the runner's store.
 *
 * Called whenever the app has the collection to hand. Cheap enough to repeat:
 * it is a handful of string writes, and being up to date matters more than
 * avoiding them.
 */
export async function syncBackgroundAlerts({ cards, settings, supabaseUrl, anonKey, priceOf }) {
  if (!isNativeApp()) return false
  const runner = await loadRunner()
  if (!runner || !supabaseUrl || !anonKey) return false

  const source = historySource(settings?.price_source)
  const minValue = settings?.price_alert_min_value ?? ALERT_DEFAULTS.price_alert_min_value
  const watch = buildWatchlist(cards, minValue, priceOf)

  const values = {
    bgUrl: supabaseUrl,
    bgKey: anonKey,
    bgCurrency: source.currency,
    bgSymbol: source.symbol,
    bgMinPct: String(settings?.price_alert_pct ?? ALERT_DEFAULTS.price_alert_pct),
    bgMinValue: String(minValue),
    bgDays: String(settings?.price_alert_days ?? ALERT_DEFAULTS.price_alert_days),
    bgWatch: watch.join('\n'),
  }

  try {
    for (const key of KV_KEYS) {
      await runner.putKV({ key, value: values[key] })
    }
    return true
  } catch {
    return false
  }
}

/**
 * Clears the mirrored data so the runner stops finding anything to report.
 *
 * Used when phone notifications are switched off, and on sign-out: leaving a
 * watchlist behind would keep notifying about a collection nobody is signed
 * into.
 */
export async function clearBackgroundAlerts() {
  if (!isNativeApp()) return
  const runner = await loadRunner()
  if (!runner) return
  try {
    for (const key of [...KV_KEYS, 'bgSeen']) {
      await runner.putKV({ key, value: '' })
    }
  } catch {
    // Nothing to recover — the runner treats missing config as "do nothing".
  }
}
