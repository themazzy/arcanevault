import { describe, it, expect } from 'vitest'
import { ANNOUNCEMENTS, ANNOUNCEMENT_BY_ID, pendingAnnouncements } from './announcements'
import { MILESTONES } from './milestones'

// Announcements ride the milestone plumbing: the client writes its own row and
// the UNIQUE (user_id, milestone_id) index makes it idempotent. That shared key
// space is why the id prefix and the "already seen" check are worth pinning.

const RELEASE = '2026-09-14'
const before = '2026-01-01T00:00:00Z'
const after = '2026-12-01T00:00:00Z'
const now = new Date('2026-09-20T00:00:00Z')

describe('ANNOUNCEMENTS', () => {
  it('namespaces every id so it cannot collide with a milestone', () => {
    // Both families share notifications.milestone_id and its unique index, so a
    // collision would silently suppress one of them.
    const milestoneIds = new Set(MILESTONES.map(m => m.id))
    for (const a of ANNOUNCEMENTS) {
      expect(a.id.startsWith('announce:')).toBe(true)
      expect(milestoneIds.has(a.id)).toBe(false)
    }
  })

  it('gives every entry the copy and destination the bell renders', () => {
    for (const a of ANNOUNCEMENTS) {
      expect(a.title).toBeTruthy()
      expect(a.body).toBeTruthy()
      expect(a.href).toBeTruthy()
      expect(a.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('is indexed by id for the bell lookup', () => {
    expect(ANNOUNCEMENT_BY_ID.size).toBe(ANNOUNCEMENTS.length)
    expect(ANNOUNCEMENT_BY_ID.get('announce:price-history')?.title).toBe('Price history charts')
  })
})

describe('pendingAnnouncements', () => {
  it('offers an unseen announcement to an account that predates it', () => {
    const pending = pendingAnnouncements(new Set(), before, now)
    expect(pending.map(a => a.id)).toContain('announce:price-history')
  })

  it('never repeats one already recorded', () => {
    const pending = pendingAnnouncements(new Set(['announce:price-history']), before, now)
    expect(pending.map(a => a.id)).not.toContain('announce:price-history')
  })

  it('accepts a plain array as well as a Set', () => {
    expect(pendingAnnouncements(['announce:price-history'], before, now)).toHaveLength(0)
  })

  it('skips an account created after the feature already existed', () => {
    // Telling a new user something is "new" when it predates their signup is
    // noise, and their first session is the worst moment to spend on it.
    expect(pendingAnnouncements(new Set(), after, now)).toHaveLength(0)
  })

  it('withholds an entry merged ahead of its release date', () => {
    const early = new Date('2026-09-01T00:00:00Z')
    expect(pendingAnnouncements(new Set(), before, early)).toHaveLength(0)
  })

  it('still announces when created_at is missing or unreadable', () => {
    // A data anomaly should not silently mute every future announcement for
    // that account; one extra notification is the cheaper failure.
    expect(pendingAnnouncements(new Set(), null, now).length).toBeGreaterThan(0)
    expect(pendingAnnouncements(new Set(), 'not-a-date', now).length).toBeGreaterThan(0)
  })

  it('keeps offering later entries once an earlier one has been seen', () => {
    // Guards the list growing: seeing one announcement must not mark the rest
    // as delivered.
    const seen = new Set(['announce:some-older-thing'])
    expect(pendingAnnouncements(seen, before, now).map(a => a.id))
      .toEqual(ANNOUNCEMENTS.filter(a => Date.parse(`${a.since}T00:00:00Z`) <= now.getTime()).map(a => a.id))
  })
})

describe('the price history announcement', () => {
  it('points at a route where the feature can actually be used', () => {
    const a = ANNOUNCEMENT_BY_ID.get('announce:price-history')
    expect(a.href).toBe('/collection')
    expect(a.since).toBe(RELEASE)
  })
})
