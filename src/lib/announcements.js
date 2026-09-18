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
/**
 * Currently empty, and that is a valid state — not a list waiting to be filled.
 *
 * The one entry it held announced the 60-day price history chart, removed on
 * 2026-09-18 along with the feature (card_price_history cost 142 MB of a 500 MB
 * database). An announcement for something that no longer exists is worse than
 * no announcement: the bell would send people to a Prices tab with nothing on
 * it. The five rows already delivered were deleted with it.
 *
 * Lesson for the next entry: an announcement outlives the release it describes,
 * because it is recorded per account. Withdrawing a feature means withdrawing
 * its announcement here AND deleting the delivered `notifications` rows, or the
 * bell renders a contentless "What's new" that navigates nowhere.
 */
export const ANNOUNCEMENTS = []

export const ANNOUNCEMENT_BY_ID = new Map(ANNOUNCEMENTS.map(a => [a.id, a]))

/**
 * Hide announcement rows whose entry no longer exists.
 *
 * A row is recorded per account, so it outlives the release it describes. Two
 * ways an orphan appears: the rows already delivered when a feature is
 * withdrawn, and the new ones a client keeps writing for as long as its service
 * worker still serves the previous bundle (~20 min after a deploy — this
 * happened on 2026-09-18, 13 minutes after the price-chart removal shipped).
 *
 * The bell fell back to a bare "What's new" with no body and no destination for
 * those, so dropping them is the difference between a withdrawn feature being
 * invisible and it being a broken row. Every other type passes through
 * untouched — only announcements carry copy that lives in the bundle.
 */
export function withKnownAnnouncements(rows) {
  return (rows || []).filter(n => n.type !== 'announcement' || ANNOUNCEMENT_BY_ID.has(n.milestone_id))
}

/**
 * Which announcements this account should be shown.
 *
 * `existing` is the set of ids already recorded, so this stays correct when the
 * list grows: a user who has seen one announcement still gets the next.
 *
 * `list` exists only so the tests can exercise the release gating against a
 * fixture. ANNOUNCEMENTS is legitimately empty between features, and the rules
 * below are subtle enough that they should stay covered while it is.
 */
export function pendingAnnouncements(existingIds, accountCreatedAt, now = new Date(), list = ANNOUNCEMENTS) {
  const seen = existingIds instanceof Set ? existingIds : new Set(existingIds || [])
  const created = accountCreatedAt ? Date.parse(accountCreatedAt) : null

  return list.filter(a => {
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
