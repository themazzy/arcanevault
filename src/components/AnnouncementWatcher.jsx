import { useEffect } from 'react'
import { useAuth } from './Auth'
import { pendingAnnouncements } from '../lib/announcements'
import { fetchRecordedKeys, recordAnnouncementNotifications } from '../lib/community'

/**
 * Records release announcements into the notification bell, once per account.
 *
 * Mounted beside MilestoneWatcher and built the same way: the client writes its
 * own rows, and the UNIQUE (user_id, milestone_id) index makes it idempotent,
 * so there is no fan-out job and no service-role broadcast.
 *
 * Failures are swallowed. An announcement is the least important thing on
 * screen, and a user who is offline or whose insert races another tab should
 * see nothing at all rather than an error — the next session records it.
 */
export default function AnnouncementWatcher() {
  const { user } = useAuth() ?? {}

  useEffect(() => {
    if (!user?.id) return undefined
    let cancelled = false

    // Deferred so it never competes with the first paint; announcements are the
    // lowest-priority write in the app.
    const timer = setTimeout(async () => {
      try {
        const seen = await fetchRecordedKeys(user.id)
        if (cancelled) return
        const pending = pendingAnnouncements(seen, user.created_at)
        if (!pending.length || cancelled) return
        await recordAnnouncementNotifications(user.id, pending.map(a => a.id))
      } catch {
        // Intentionally silent — see above.
      }
    }, 4000)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [user?.id, user?.created_at])

  return null
}
