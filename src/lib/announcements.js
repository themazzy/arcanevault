/**
 * Release announcements shown in the notification bell.
 *
 * "What's New" on Home is a collapsed panel, so a feature can ship and never be
 * noticed. The bell is where people already look for "something happened".
 *
 * Each entry is recorded once per account, deduped by the existing
 * UNIQUE (user_id, milestone_id) index — no fan-out job and no service-role
 * broadcast, exactly how milestones already work. Ids carry an `announce:`
 * prefix so they can never collide with a milestone id.
 *
 * `since` stops an announcement reaching accounts created after the feature
 * already existed: telling a brand-new user that something is "new" when it was
 * there before they signed up is noise, and their first session is the worst
 * moment to spend a notification on it.
 *
 * Keep this list short. Every entry is an interruption, so it earns its place
 * only if a user would want to go and look at the thing.
 */
export const ANNOUNCEMENTS = [
  {
    id: 'announce:price-history',
    icon: '📈',
    title: 'Price history charts',
    body: 'Every card now has a 60-day price chart on its Prices tab, in whichever marketplace you price in.',
    href: '/collection',
    since: '2026-09-14',
  },
]

export const ANNOUNCEMENT_BY_ID = new Map(ANNOUNCEMENTS.map(a => [a.id, a]))

/**
 * Which announcements this account should be shown.
 *
 * `existing` is the set of ids already recorded, so this stays correct when the
 * list grows: a user who has seen one announcement still gets the next.
 */
export function pendingAnnouncements(existingIds, accountCreatedAt, now = new Date()) {
  const seen = existingIds instanceof Set ? existingIds : new Set(existingIds || [])
  const created = accountCreatedAt ? Date.parse(accountCreatedAt) : null

  return ANNOUNCEMENTS.filter(a => {
    if (seen.has(a.id)) return false
    const releasedAt = Date.parse(`${a.since}T00:00:00Z`)
    // Not yet released — lets an entry be merged ahead of its ship date.
    if (Number.isFinite(releasedAt) && releasedAt > now.getTime()) return false
    // Account predates the feature, or we cannot tell. An unreadable created_at
    // is a data anomaly, and showing one extra notification is a far smaller
    // cost than silently never announcing anything to that account.
    if (!Number.isFinite(created) || !Number.isFinite(releasedAt)) return true
    return created < releasedAt
  })
}
