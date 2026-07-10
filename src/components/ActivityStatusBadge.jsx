import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useIsFetching } from '@tanstack/react-query'
import { subscribeActivity, getActivityCount } from '../lib/activity'
import styles from './ActivityStatusBadge.module.css'

// App-wide activity indicator: a floating pill that pops up while any data is
// loading/saving (React Query fetches + trackActivity-wrapped Supabase work) or
// while offline, then fades out when idle. Promoted from the old Collection-only
// badge so it reflects activity on every page. Renders nothing when idle + online.
const SHOW_DELAY_MS = 250   // ignore sub-250ms cache-served fetches so it doesn't flicker
const FADE_AFTER_MS = 1800  // begin fade this long after going idle
const HIDE_AFTER_MS = 2200

export default function ActivityStatusBadge() {
  const fetching = useIsFetching()
  // Raw Supabase writes/reads outside React Query report through src/lib/activity.js.
  const tracked = useSyncExternalStore(subscribeActivity, getActivityCount)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)
  const timers = useRef([])

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const busy = fetching > 0 || tracked > 0
  const active = !online || busy

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    if (active) {
      // Offline shows at once; busy waits a beat so instant cache reads don't flash.
      const delay = online ? SHOW_DELAY_MS : 0
      timers.current.push(setTimeout(() => { setVisible(true); setExiting(false) }, delay))
    } else {
      timers.current.push(setTimeout(() => setExiting(true), FADE_AFTER_MS))
      timers.current.push(setTimeout(() => { setVisible(false); setExiting(false) }, HIDE_AFTER_MS))
    }
    return () => { timers.current.forEach(clearTimeout); timers.current = [] }
  }, [active, online])

  if (!visible) return null

  const tone = !online ? 'offline' : busy ? 'loading' : 'online'
  const label = !online ? 'Offline' : busy ? 'Syncing…' : 'Up to date'

  return (
    <div
      className={`${styles.badge} ${styles[`badge_${tone}`]}${exiting ? ' ' + styles.badge_exit : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className={styles.dot} />
      {label}
    </div>
  )
}
