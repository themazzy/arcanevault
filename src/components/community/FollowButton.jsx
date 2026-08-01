import { Button } from '../UI'

// The follow toggle only. It used to fetch getUserFollowStats itself, which meant
// the profile page ran that RPC twice on every load — once here and once for the
// ownership check. The page owns the fetch now and passes the result down, and it
// renders the follower counts itself so they can be clickable.
export default function FollowButton({ stats, user, busy = false, onToggle }) {
  if (!stats || !user || stats.is_self) return null

  const following = !!stats.viewer_following

  return (
    <Button
      variant={following ? 'secondary' : 'primary'}
      size="sm"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={following}
    >
      {following ? 'Following' : 'Follow'}
    </Button>
  )
}
