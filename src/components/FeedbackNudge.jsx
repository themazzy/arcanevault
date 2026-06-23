import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { InfoIcon, CloseIcon } from '../icons'
import styles from './FeedbackNudge.module.css'

const DISMISS_KEY = 'av_feedback_nudge_dismissed'
const FORCE_KEY = 'av_feedback_nudge_force'
export const MIN_ACCOUNT_AGE_DAYS = 3

const isDismissed = () => {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

// One-shot manual trigger: set localStorage 'av_feedback_nudge_force' = '1'
// (then reload) to show the nudge once, bypassing the age/feedback/dismiss
// gates. Consumed immediately so it only fires a single time.
const consumeForce = () => {
  try {
    if (localStorage.getItem(FORCE_KEY) === '1') {
      localStorage.removeItem(FORCE_KEY)
      return true
    }
  } catch {}
  return false
}

const markDismissed = () => {
  try { localStorage.setItem(DISMISS_KEY, '1') } catch {}
}

const daysSince = (iso, now = Date.now()) => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return (now - t) / 86_400_000
}

/**
 * Pure gate for whether the account is old enough and not dismissed. The
 * "already sent feedback" check is async and applied separately. Exported for
 * testing.
 */
export function isNudgeEligible({ createdAt, dismissed, now = Date.now() } = {}) {
  if (dismissed) return false
  if (!createdAt) return false
  return daysSince(createdAt, now) >= MIN_ACCOUNT_AGE_DAYS
}

/**
 * Gentle, dismissable corner card shown to users who have had an account for a
 * few days and haven't sent feedback yet. The button opens the full feedback
 * modal (state lifted to Layout). Dismissal persists in localStorage.
 */
export default function FeedbackNudge({ onOpenFeedback }) {
  const { user } = useAuth()
  const [show, setShow] = useState(false)

  useEffect(() => {
    let cancelled = false

    // Manual one-shot override — show immediately, skip all gates.
    if (consumeForce()) { setShow(true); return }

    if (!isNudgeEligible({ createdAt: user?.created_at, dismissed: isDismissed() })) return

    // Don't nag users who have already shared feedback.
    sb.from('feedback')
      .select('id')
      .eq('user_id', user.id)
      .limit(1)
      .then(({ data }) => {
        if (cancelled) return
        if (data && data.length > 0) return
        setShow(true)
      })

    return () => { cancelled = true }
  }, [user])

  if (!show) return null

  const dismiss = () => {
    markDismissed()
    setShow(false)
  }

  const openFeedback = () => {
    markDismissed()
    setShow(false)
    onOpenFeedback?.()
  }

  return (
    <div className={styles.nudge} role="dialog" aria-label="Share your feedback">
      <button className={styles.close} onClick={dismiss} aria-label="Dismiss">
        <CloseIcon size={14} />
      </button>
      <div className={styles.head}>
        <span className={styles.icon}><InfoIcon size={16} /></span>
        <span className={styles.title}>Enjoying DeckLoom?</span>
      </div>
      <p className={styles.body}>
        You've been around a few days now — I'd love to hear what's working,
        what's missing, or anything that's bugged you. It directly shapes what
        ships next.
      </p>
      <div className={styles.actions}>
        <button className={styles.later} onClick={dismiss}>Maybe later</button>
        <button className={styles.primary} onClick={openFeedback}>Share feedback</button>
      </div>
    </div>
  )
}
