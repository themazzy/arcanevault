import { useState, useEffect, useCallback } from 'react'
import { getUserFollowStats, setFollow } from '../../lib/community'
import styles from './FollowButton.module.css'

// Follower/following counts + a follow toggle for a public profile.
// `username` is the profile's nickname; `user` is the signed-in viewer.
export default function FollowButton({ username, user }) {
  const [stats, setStats] = useState(null)   // { user_id, follower_count, following_count, viewer_following, is_self }
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    getUserFollowStats(username).then(s => { if (alive) setStats(s) }).catch(() => {})
    return () => { alive = false }
  }, [username])

  const toggle = useCallback(async () => {
    if (!user || !stats || stats.is_self || busy) return
    const next = !stats.viewer_following
    setBusy(true)
    setStats(s => ({ ...s, viewer_following: next, follower_count: Math.max(0, (s.follower_count || 0) + (next ? 1 : -1)) }))
    try { await setFollow(user.id, stats.user_id, next) }
    catch { setStats(s => ({ ...s, viewer_following: !next, follower_count: Math.max(0, (s.follower_count || 0) + (next ? -1 : 1)) })) }
    finally { setBusy(false) }
  }, [user, stats, busy])

  if (!stats) return null
  const canFollow = user && !stats.is_self

  return (
    <div className={styles.wrap}>
      <span className={styles.stat}><strong>{stats.follower_count}</strong> follower{stats.follower_count === 1 ? '' : 's'}</span>
      <span className={styles.dot}>·</span>
      <span className={styles.stat}><strong>{stats.following_count}</strong> following</span>
      {canFollow && (
        <button
          className={`${styles.btn} ${stats.viewer_following ? styles.btnFollowing : ''}`}
          onClick={toggle}
          disabled={busy}
        >
          {stats.viewer_following ? 'Following' : 'Follow'}
        </button>
      )}
    </div>
  )
}
