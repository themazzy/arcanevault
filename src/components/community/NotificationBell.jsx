import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getMyNotifications, getUnreadNotificationCount, markAllNotificationsRead } from '../../lib/community'
import { BellIcon } from '../../icons'
import styles from './NotificationBell.module.css'

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const VERB = { like: 'liked', comment: 'commented on', follow: 'started following you', trade_proposal: 'sent you a trade proposal' }

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [notes, setNotes] = useState(null)   // null = not loaded
  const wrapRef = useRef(null)
  const navigate = useNavigate()

  const refreshCount = useCallback(() => {
    getUnreadNotificationCount().then(setUnread).catch(() => {})
  }, [])

  useEffect(() => {
    refreshCount()
    const t = setInterval(refreshCount, 60000)
    return () => clearInterval(t)
  }, [refreshCount])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next) {
      getMyNotifications(30).then(setNotes).catch(() => setNotes([]))
      if (unread > 0) {
        setUnread(0)
        try { await markAllNotificationsRead() } catch {}
      }
    }
  }

  const go = (n) => {
    setOpen(false)
    if (n.type === 'trade_proposal') {
      navigate('/trading?tab=proposals')
    } else if (n.type === 'follow') {
      if (n.actor_name) navigate(`/profile/${encodeURIComponent(n.actor_name)}`)
    } else if (n.deck_id) {
      navigate(`/d/${n.deck_id}`)
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button className={styles.bell} onClick={toggle} aria-label="Notifications" title="Notifications">
        <BellIcon size={16} />
        {unread > 0 && <span className={styles.badge}>{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.head}>Notifications</div>
          {notes === null ? (
            <div className={styles.empty}>Loading…</div>
          ) : notes.length === 0 ? (
            <div className={styles.empty}>Nothing yet. Likes, comments and follows show up here.</div>
          ) : (
            <ul className={styles.list}>
              {notes.map(n => (
                <li key={n.id}>
                  <button className={`${styles.item} ${n.read ? '' : styles.itemUnread}`} onClick={() => go(n)}>
                    <span className={styles.text}>
                      <strong>{n.actor_name || 'Someone'}</strong> {VERB[n.type] || 'interacted'}
                      {n.type !== 'follow' && n.deck_name ? <> <span className={styles.deck}>{n.deck_name}</span></> : null}
                    </span>
                    <span className={styles.time}>{timeAgo(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
