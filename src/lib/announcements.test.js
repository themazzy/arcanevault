import { describe, it, expect } from 'vitest'
import { ANNOUNCEMENTS, ANNOUNCEMENT_BY_ID, pendingAnnouncements, withKnownAnnouncements } from './announcements'
import { MILESTONES } from './milestones'

// Announcements ride the milestone plumbing: the client writes its own row and
// the UNIQUE (user_id, milestone_id) index makes it idempotent. That shared key
// space is why the id prefix and the "already seen" check are worth pinning.
//
// ANNOUNCEMENTS is empty between features (see the note there), so the gating
// rules are exercised against this fixture rather than the shipped list —
// otherwise every assertion below would pass vacuously and the logic would be
// uncovered exactly when the next entry is added.

const RELEASE = '2026-09-14'
const FIXTURE = [
  { id: 'announce:fixture', icon: '📈', title: 'A feature', body: 'It does things.', href: '/collection', since: RELEASE },
]

const before = '2026-01-01T00:00:00Z'
const after = '2026-12-01T00:00:00Z'
const now = new Date('2026-09-20T00:00:00Z')

describe('ANNOUNCEMENTS', () => {
  it('namespaces every id so it cannot collide with a milestone', () => {
    // Both families share notifications.milestone_id and its unique index, so a
    // collision would silently suppress one of them.
    const milestoneIds = new Set(MILESTONES.map(m => m.id))
    for (const a of [...ANNOUNCEMENTS, ...FIXTURE]) {
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
  })

  // The price history chart was removed 2026-09-18 with its 142 MB table. The
  // bell records a row per account, so a withdrawn feature must not be left
  // advertised here — it would send people to an empty Prices tab.
  it('no longer announces the removed price history chart', () => {
    expect(ANNOUNCEMENT_BY_ID.has('announce:price-history')).toBe(false)
    expect(JSON.stringify(ANNOUNCEMENTS)).not.toMatch(/price history/i)
  })
})

describe('pendingAnnouncements', () => {
  it('offers an unseen announcement to an account that predates it', () => {
    const pending = pendingAnnouncements(new Set(), before, now, FIXTURE)
    expect(pending.map(a => a.id)).toEqual(['announce:fixture'])
  })

  it('never repeats one already recorded', () => {
    const pending = pendingAnnouncements(new Set(['announce:fixture']), before, now, FIXTURE)
    expect(pending).toHaveLength(0)
  })

  it('accepts a plain array as well as a Set', () => {
    expect(pendingAnnouncements(['announce:fixture'], before, now, FIXTURE)).toHaveLength(0)
  })

  it('skips an account created after the feature already existed', () => {
    // Telling a new user something is "new" when it predates their signup is
    // noise, and their first session is the worst moment to spend on it.
    expect(pendingAnnouncements(new Set(), after, now, FIXTURE)).toHaveLength(0)
  })

  it('withholds an entry merged ahead of its release date', () => {
    const early = new Date('2026-09-01T00:00:00Z')
    expect(pendingAnnouncements(new Set(), before, early, FIXTURE)).toHaveLength(0)
  })

  it('still announces when created_at is missing or unreadable', () => {
    // A data anomaly should not silently mute every future announcement for
    // that account; one extra notification is the cheaper failure.
    expect(pendingAnnouncements(new Set(), null, now, FIXTURE)).toHaveLength(1)
    expect(pendingAnnouncements(new Set(), 'not-a-date', now, FIXTURE)).toHaveLength(1)
  })

  it('keeps offering later entries once an earlier one has been seen', () => {
    // Guards the list growing: seeing one announcement must not mark the rest
    // as delivered.
    const seen = new Set(['announce:some-older-thing'])
    expect(pendingAnnouncements(seen, before, now, FIXTURE).map(a => a.id)).toEqual(['announce:fixture'])
  })

  it('returns nothing while the shipped list is empty', () => {
    // The real call site passes no list. An empty ANNOUNCEMENTS must be a quiet
    // no-op, not an error, or AnnouncementWatcher throws on every session.
    expect(pendingAnnouncements(new Set(), before, now)).toEqual([])
  })
})

describe('withKnownAnnouncements', () => {
  // A row is recorded per account, so it outlives the release it describes.
  // Measured on 2026-09-18: a client whose service worker still served the
  // previous bundle re-recorded announce:price-history 13 minutes AFTER the
  // removal deployed, so deleting the rows alone cannot be the whole fix.
  it('hides an announcement whose entry no longer exists', () => {
    const rows = [
      { id: 1, type: 'announcement', milestone_id: 'announce:price-history' },
      { id: 2, type: 'milestone', milestone_id: 'first-deck' },
    ]
    expect(withKnownAnnouncements(rows).map(r => r.id)).toEqual([2])
  })

  it('keeps every non-announcement type untouched', () => {
    // Only announcements carry copy that lives in the bundle; the others render
    // from the row itself, so an unknown id is not a reason to drop them.
    const rows = [
      { id: 1, type: 'price_alert', milestone_id: 'price:abc:2026-09-17:normal' },
      { id: 2, type: 'milestone', milestone_id: 'not-a-known-milestone' },
      { id: 3, type: 'follow', milestone_id: null },
      { id: 4, type: 'comment', milestone_id: null },
    ]
    expect(withKnownAnnouncements(rows)).toHaveLength(4)
  })

  it('survives a null or empty list', () => {
    expect(withKnownAnnouncements(null)).toEqual([])
    expect(withKnownAnnouncements(undefined)).toEqual([])
    expect(withKnownAnnouncements([])).toEqual([])
  })
})
