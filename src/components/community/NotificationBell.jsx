import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearNotifications, deleteNotification, getMyNotifications, getUnreadNotificationCount, markAllNotificationsRead } from '../../lib/community'
import { MILESTONES } from '../../lib/milestones'
import { ANNOUNCEMENT_BY_ID } from '../../lib/announcements'
import { fetchAlertDetails, parseAlertKey } from '../../lib/priceAlerts'
import { useAuth } from '../Auth'
import { useSettings } from '../SettingsContext'
import { BellIcon, CloseIcon } from '../../icons'
import styles from './NotificationBell.module.css'

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const VERB = {
  like: 'liked',
  comment: 'commented on',
  follow: 'started following you',
  trade_proposal: 'sent you a trade proposal',
  // Covers both an accept/decline and a "we traded" confirmation — the
  // proposals tab shows which, and it keeps one notification type for the
  // whole post-proposal conversation.
  trade_response: 'updated a trade with you',
}

const MILESTONE_BY_ID = new Map(MILESTONES.map(m => [m.id, m]))

// Matches the row-leave animation in the stylesheet.
const LEAVE_MS = 160

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [notes, setNotes] = useState(null)   // null = not loaded
  // Price alerts carry only a key; the move and the card name are looked up
  // when the bell opens, not stored on the notification row.
  const [alertDetails, setAlertDetails] = useState(new Map())
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  // Rows animate out before they are removed, so the list does not jump.
  const [leaving, setLeaving] = useState(() => new Set())
  const wrapRef = useRef(null)
  const navigate = useNavigate()
  const { nickname } = useSettings()
  const { user } = useAuth() ?? {}

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
    if (!next) setConfirming(false)
    if (next) {
      getMyNotifications(30).then(rows => {
        setNotes(rows)
        const keys = rows.filter(r => r.type === 'price_alert').map(r => r.milestone_id)
        if (keys.length) fetchAlertDetails(keys).then(setAlertDetails).catch(() => {})
      }).catch(() => setNotes([]))
      if (unread > 0) {
        setUnread(0)
        try { await markAllNotificationsRead() } catch {}
      }
    }
  }

  const dismiss = async (id) => {
    setLeaving(prev => new Set(prev).add(id))
    try {
      await deleteNotification(user?.id, id)
    } catch {
      // Put it back rather than leaving a row that looks gone but is not.
      setLeaving(prev => { const next = new Set(prev); next.delete(id); return next })
      return
    }
    setTimeout(() => {
      setNotes(prev => (prev || []).filter(n => n.id !== id))
      setLeaving(prev => { const next = new Set(prev); next.delete(id); return next })
    }, LEAVE_MS)
  }

  const handleClear = async () => {
    if (!confirming) { setConfirming(true); return }
    setClearing(true)
    try {
      await clearNotifications(user?.id)
      setNotes([])
      setUnread(0)
      setAlertDetails(new Map())
    } catch {
      // Leaving the rows in place is the safe failure: nothing was lost, and
      // the next tap tries again.
    } finally {
      setClearing(false)
      setConfirming(false)
    }
  }

  const go = (n) => {
    setOpen(false)
    if (n.type === 'price_alert') {
      // Straight to the card's own page, where the chart explains the move.
      const parsed = parseAlertKey(n.milestone_id)
      if (parsed) navigate(`/collection?card=${parsed.scryfall_id}&foil=${parsed.finish === 'foil' ? 1 : 0}`)
    } else if (n.type === 'announcement') {
      // Straight to the feature being announced — an announcement nobody can
      // act on is just noise.
      const announcement = ANNOUNCEMENT_BY_ID.get(n.milestone_id)
      if (announcement?.href) navigate(announcement.href)
    } else if (n.type === 'milestone') {
      // The milestones block lives on the owner's own profile.
      if (nickname) navigate(`/profile/${encodeURIComponent(nickname)}`)
    } else if (n.type === 'trade_proposal' || n.type === 'trade_response') {
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
            <div className={styles.empty}>Nothing yet. Updates, milestones, likes, comments and follows show up here.</div>
          ) : (
            <ul className={styles.list}>
              {notes.map((n, i) => {
                const milestone = n.type === 'milestone' ? MILESTONE_BY_ID.get(n.milestone_id) : null
                const announcement = n.type === 'announcement' ? ANNOUNCEMENT_BY_ID.get(n.milestone_id) : null
                return (
                  <li
                    key={n.id}
                    /* A row is a wrapper, not a button: the dismiss control is
                       itself a button and one cannot nest inside another. */
                    className={`${styles.row} ${leaving.has(n.id) ? styles.rowLeaving : ''}`}
                    style={{ animationDelay: `${Math.min(i, 8) * 22}ms` }}
                  >
                    <button className={`${styles.item} ${n.read ? '' : styles.itemUnread}`} onClick={() => go(n)}>
                      <span className={styles.text}>
                        {n.type === 'price_alert' ? (() => {
                          const move = alertDetails.get(n.milestone_id)
                          const rose = (move?.delta ?? 0) > 0
                          const symbol = move?.currency === 'usd' ? '$' : '€'
                          return (
                            <>
                              <span className={styles.milestoneIcon}>{rose ? '📈' : '📉'}</span>
                              <strong>{move?.name || 'A card you own'}</strong>
                              {move ? (
                                <span className={styles.announcementBody}>
                                  {move.finish === 'foil' ? 'Foil ' : ''}
                                  {rose ? 'rose' : 'fell'} {Math.abs(move.pct).toFixed(0)}% to {symbol}{move.price_to.toFixed(2)}
                                  {' '}on {move.move_date}
                                </span>
                              ) : (
                                // The move aged out of the 7-day table before the
                                // bell was opened. The notification is still true,
                                // so it says what it can rather than vanishing.
                                <span className={styles.announcementBody}>moved sharply in price</span>
                              )}
                            </>
                          )
                        })() : n.type === 'announcement' ? (
                          <>
                            <span className={styles.milestoneIcon}>{announcement?.icon || '✨'}</span>
                            <strong>{announcement?.title || 'What’s new'}</strong>
                            {announcement?.body ? <span className={styles.announcementBody}>{announcement.body}</span> : null}
                          </>
                        ) : n.type === 'milestone' ? (
                          <>
                            <span className={styles.milestoneIcon}>{milestone?.icon || '🏆'}</span>
                            Milestone unlocked — <strong>{milestone?.label || 'New milestone'}</strong>
                          </>
                        ) : (
                          <>
                            <strong>{n.actor_name || 'Someone'}</strong> {VERB[n.type] || 'interacted'}
                            {n.type !== 'follow' && n.deck_name ? <> <span className={styles.deck}>{n.deck_name}</span></> : null}
                          </>
                        )}
                      </span>
                      <span className={styles.time}>{timeAgo(n.created_at)}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.dismiss}
                      onClick={() => dismiss(n.id)}
                      aria-label="Dismiss notification"
                      title="Dismiss"
                    >
                      <CloseIcon size={11} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {!!notes?.length && (
            <div className={styles.footer}>
              {/* Two-step rather than a modal: these are low-value rows and a
                  confirm dialog for them would be heavier than the thing it
                  protects. The button says what the next click does. */}
              <button
                type="button"
                className={`${styles.clear} ${confirming ? styles.clearArmed : ''}`}
                onClick={handleClear}
                disabled={clearing}
              >
                {clearing ? 'Clearing…' : confirming ? 'Tap again to clear all' : 'Clear all'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
