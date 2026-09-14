import { useEffect, useMemo } from 'react'
import { useAuth } from './Auth'
import { useSettings } from './SettingsContext'
import { getLocalCardPriceRowsByIds, getLocalCards } from '../lib/db'
import { alertsFor, fetchRecentMoves, indexOwned, windowCutoff } from '../lib/priceAlerts'
import { fetchRecordedKeys, recordPriceAlertNotifications } from '../lib/community'
import { historySource } from '../lib/priceHistory'
import { notifyPriceAlerts } from '../lib/nativeNotifications'
import { clearBackgroundAlerts, syncBackgroundAlerts } from '../lib/backgroundAlerts'

/**
 * Today's cached market price per printing, as a lookup.
 *
 * Owned rows carry only `purchase_price`, which is the wrong number here: a
 * card bought cheap that has since climbed is exactly the one worth watching,
 * and filtering on what was paid would drop it. Market prices live in their own
 * IDB store, so they are read from there and folded into a map once rather than
 * looked up per card.
 *
 * Returns a function so the watchlist builder stays pure and injectable.
 */
async function marketPriceLookup(cards, priceSourceId) {
  const usd = historySource(priceSourceId).currency === 'usd'
  const ids = [...new Set((cards || []).map(c => c?.scryfall_id).filter(Boolean))]
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  const byId = new Map()
  try {
    const rows = await getLocalCardPriceRowsByIds(ids, [today, yesterday])
    for (const row of rows) {
      // Today wins; yesterday is the fallback before the daily sync lands.
      if (row.snapshot_date === yesterday && byId.has(row.scryfall_id)) continue
      byId.set(row.scryfall_id, row)
    }
  } catch {
    // No cached prices yet. Everything then scores 0 and the watchlist comes
    // back empty, which is correct: with no prices there is nothing to judge.
  }

  return card => {
    const row = byId.get(card?.scryfall_id)
    if (!row) return 0
    const foil = !!card?.foil
    const value = usd
      ? (foil ? row.price_foil_usd : row.price_regular_usd)
      : (foil ? row.price_foil_eur : row.price_regular_eur)
    return Number(value) || 0
  }
}

/**
 * Turns the catalogue-wide mover list into notifications for this user's cards.
 *
 * Nothing about this costs the server anything per user: the movers were
 * computed once by the ingest job, the collection is already in IDB, and the
 * intersection happens here. The rows it writes are the same self-insert
 * pattern as milestones and announcements, deduped by the existing
 * UNIQUE (user_id, milestone_id) on a `price:<id>:<date>:<finish>` key — so a
 * card that moves on two days produces two alerts, and two devices seeing the
 * same move produce one.
 *
 * Failures are swallowed. A missed alert is recoverable on the next load; an
 * error toast about one is not worth interrupting anybody for.
 */
export default function PriceAlertWatcher() {
  const { user } = useAuth() ?? {}
  const settings = useSettings()
  // Read off the fields rather than passing `settings` into the effect: the
  // context hands back a new object every render, so depending on it would
  // re-run this on any settings change anywhere in the app — and depending on
  // the fields while still *using* the object is what tripped the lint rule.
  const enabled = settings?.price_alerts_enabled !== false
  const days = settings?.price_alert_days ?? 7
  const priceSource = settings?.price_source
  const phoneEnabled = settings?.phone_notifications_enabled !== false
  const notificationKey = settings?.notification_key
  const thresholds = useMemo(() => ({
    price_alert_pct: settings?.price_alert_pct,
    price_alert_min_value: settings?.price_alert_min_value,
  }), [settings?.price_alert_pct, settings?.price_alert_min_value])

  useEffect(() => {
    if (!user?.id || !enabled) return undefined
    let cancelled = false

    // Deferred behind first paint, and behind MilestoneWatcher: this is the
    // least urgent read in the app.
    const timer = setTimeout(async () => {
      try {
        const cards = await getLocalCards(user.id)
        if (cancelled) return

        // Read before the mirror so the runner can be told what the app has
        // already raised, and reused below rather than fetched twice.
        const known = await fetchRecordedKeys(user.id)
        if (cancelled) return

        // Mirrored BEFORE the movers are examined, and regardless of whether
        // there are any: the runner's watchlist has to stay current on quiet
        // days too, or it goes stale exactly while nothing prompts a refresh.
        // Cleared rather than skipped when the phone toggle is off, so turning
        // it off actually stops the buzzing.
        if (phoneEnabled) {
          syncBackgroundAlerts({
            cards,
            settings: {
              price_source: priceSource,
              ...thresholds,
              price_alert_days: days,
              notification_key: notificationKey,
            },
            supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
            anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            priceOf: await marketPriceLookup(cards, priceSource),
            seenKeys: [...known].filter(k => String(k).startsWith('price:')),
          }).catch(() => {})
        } else {
          clearBackgroundAlerts().catch(() => {})
        }

        const moves = await fetchRecentMoves(windowCutoff(days))
        if (cancelled || !moves.length) return

        const alerts = alertsFor(moves, indexOwned(cards), thresholds, priceSource)
        if (!alerts.length || cancelled) return

        // Capped: a genuinely wild day should not bury every other
        // notification, and the Movers panel shows the full list anyway.
        const batch = alerts.slice(0, 10)
        await recordPriceAlertNotifications(user.id, batch.map(a => a.key))
        if (cancelled) return

        // Only the ones that were not already recorded get a phone
        // notification. Without this, every app open would re-buzz about the
        // same move for as long as it stayed inside the look-back window.
        const fresh = batch.filter(a => !known.has(a.key))
        if (fresh.length && phoneEnabled) {
          await notifyPriceAlerts(fresh, { symbol: historySource(priceSource).symbol })
        }
      } catch {
        // Intentionally silent — see above.
      }
    }, 6000)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [user?.id, enabled, days, thresholds, priceSource, phoneEnabled, notificationKey])

  return null
}
