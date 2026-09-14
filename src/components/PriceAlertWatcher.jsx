import { useEffect } from 'react'
import { useAuth } from './Auth'
import { useSettings } from './SettingsContext'
import { getLocalCards } from '../lib/db'
import { alertsFor, fetchRecentMoves, indexOwned, windowCutoff } from '../lib/priceAlerts'
import { recordPriceAlertNotifications } from '../lib/community'

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
  const enabled = settings?.price_alerts_enabled !== false

  useEffect(() => {
    if (!user?.id || !enabled) return undefined
    let cancelled = false

    // Deferred behind first paint, and behind MilestoneWatcher: this is the
    // least urgent read in the app.
    const timer = setTimeout(async () => {
      try {
        const cutoff = windowCutoff(settings?.price_alert_days ?? 7)
        const moves = await fetchRecentMoves(cutoff)
        if (cancelled || !moves.length) return

        const cards = await getLocalCards(user.id)
        if (cancelled) return

        const alerts = alertsFor(moves, indexOwned(cards), settings, settings?.price_source)
        if (!alerts.length || cancelled) return

        // Capped: a genuinely wild day should not bury every other
        // notification, and the Movers panel shows the full list anyway.
        await recordPriceAlertNotifications(user.id, alerts.slice(0, 10).map(a => a.key))
      } catch {
        // Intentionally silent — see above.
      }
    }, 6000)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [
    // Individual fields, not `settings` itself: the context hands back a new
    // object every render, so depending on it would re-run this on every
    // keystroke anywhere in the app.
    user?.id,
    enabled,
    settings?.price_alert_days,
    settings?.price_alert_pct,
    settings?.price_alert_min_value,
    settings?.price_source,
  ])

  return null
}
