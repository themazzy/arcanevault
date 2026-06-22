import { useEffect, useState } from 'react'
import { useIsFetching, useIsMutating } from '@tanstack/react-query'
import { useSettings } from './SettingsContext'
import styles from './SyncStatusPill.module.css'

// Compact, app-wide activity indicator shown in the navbar on every page.
// Aggregates all background work: React Query fetches + mutations, the settings
// sync state, and online/offline. Idle = quiet "Up to date"; anything in flight
// shows "Syncing…/Saving…". A short debounce keeps instant cache hits from
// flickering the pill.

function ago(ts) {
  if (!ts) return null
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function SyncStatusPill() {
  const fetching = useIsFetching()
  const mutating = useIsMutating()
  const { syncState, lastSyncedAt, syncError, reduce_motion } = useSettings()
  const [online, setOnline] = useState(() => navigator.onLine)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const active = fetching > 0 || mutating > 0 || syncState === 'syncing' || syncState === 'pending'

  // Debounce the busy state so a sub-350ms cache-backed fetch doesn't flash.
  useEffect(() => {
    if (!active) { setBusy(false); return }
    const t = setTimeout(() => setBusy(true), 350)
    return () => clearTimeout(t)
  }, [active])

  let state, label, title
  if (!online) {
    state = 'offline'; label = 'Offline'; title = 'You’re offline — showing saved data'
  } else if (busy) {
    state = 'busy'
    label = mutating > 0 ? 'Saving…' : 'Syncing…'
    title = mutating > 0 ? 'Saving your changes…' : 'Syncing your latest data…'
  } else if (syncState === 'error') {
    state = 'error'; label = 'Sync error'; title = syncError || 'The last sync failed'
  } else {
    state = 'idle'; label = 'Up to date'
    const a = ago(lastSyncedAt)
    title = a ? `Up to date · last synced ${a}` : 'Up to date'
  }

  return (
    <div
      className={`${styles.pill} ${styles[state]}${reduce_motion ? ` ${styles.noMotion}` : ''}`}
      title={title}
      role="status"
      aria-live="polite"
      aria-label={title}
    >
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
    </div>
  )
}
