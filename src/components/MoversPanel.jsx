import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './Auth'
import { useSettings } from './SettingsContext'
import { getLocalCards } from '../lib/db'
import { alertsFor, fetchRecentMoves, indexOwned, windowCutoff } from '../lib/priceAlerts'
import { historySource } from '../lib/priceHistory'
import styles from './MoversPanel.module.css'

/**
 * Biggest price moves among cards the user owns.
 *
 * Same data and same filter as the notifications — the movers were computed
 * once for the whole catalogue by the ingest job, and this intersects them with
 * the collection already in IDB. The panel is the browsable form; the bell is
 * the interruption form.
 *
 * Ranked by effect on the holding rather than by percentage, so four copies of
 * a staple outrank one bulk rare that happened to double.
 */
const SHOWN = 5

export default function MoversPanel() {
  const { user } = useAuth() ?? {}
  const settings = useSettings()
  const navigate = useNavigate()
  const [state, setState] = useState({ status: 'loading', alerts: [] })

  // Read off the fields rather than passing `settings` into the effect: the
  // context hands back a new object every render, so depending on it would
  // re-run this on any settings change anywhere in the app — and depending on
  // the fields while still *using* the object is what tripped the lint rule.
  const days = settings?.price_alert_days ?? 7
  const priceSource = settings?.price_source
  const source = historySource(priceSource)
  const thresholds = useMemo(() => ({
    price_alert_pct: settings?.price_alert_pct,
    price_alert_min_value: settings?.price_alert_min_value,
  }), [settings?.price_alert_pct, settings?.price_alert_min_value])

  useEffect(() => {
    if (!user?.id) return undefined
    let cancelled = false

    ;(async () => {
      try {
        const moves = await fetchRecentMoves(windowCutoff(days))
        const cards = await getLocalCards(user.id)
        if (cancelled) return
        setState({
          status: 'ready',
          alerts: alertsFor(moves, indexOwned(cards), thresholds, priceSource),
        })
      } catch {
        if (!cancelled) setState({ status: 'error', alerts: [] })
      }
    })()

    return () => { cancelled = true }
  }, [user?.id, days, thresholds, priceSource])

  const shown = useMemo(() => state.alerts.slice(0, SHOWN), [state.alerts])
  const money = v => `${source.symbol}${Math.abs(v).toFixed(2)}`

  // A quiet market is the normal case at these thresholds, so the panel hides
  // itself rather than sitting on Home saying nothing happened.
  if (state.status !== 'ready' || !shown.length) return null

  return (
    <section className={styles.panel} aria-labelledby="movers-title">
      <div className={styles.head}>
        <h2 id="movers-title" className={styles.title}>Movers</h2>
        <span className={styles.sub}>
          {source.label} · {days === 1 ? 'today' : `last ${days} days`}
        </span>
      </div>

      <ul className={styles.list}>
        {shown.map(a => {
          const rose = a.delta > 0
          return (
            <li key={a.key}>
              <button
                type="button"
                className={styles.row}
                onClick={() => navigate(`/collection?card=${a.scryfall_id}&foil=${a.finish === 'foil' ? 1 : 0}`)}
              >
                <span className={styles.name}>
                  {a.name || 'Unknown card'}
                  {a.finish === 'foil' && <span className={styles.foilTag}>foil</span>}
                  {a.qty > 1 && <span className={styles.qty}>×{a.qty}</span>}
                </span>
                <span className={styles.figures}>
                  <span className={rose ? styles.up : styles.down}>
                    {rose ? '▲' : '▼'} {Math.abs(a.pct).toFixed(0)}%
                  </span>
                  <span className={styles.price}>{money(a.price_to)}</span>
                  {/* What the move did to the holding — the reason this row
                      outranks a bigger percentage on a single cheap copy. */}
                  <span className={styles.holding}>
                    {rose ? '+' : '−'}{money(a.holdingDelta)}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {state.alerts.length > SHOWN && (
        <p className={styles.more}>
          and {state.alerts.length - SHOWN} more
        </p>
      )}
    </section>
  )
}
