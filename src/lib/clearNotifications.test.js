import { describe, it, expect, vi, beforeEach } from 'vitest'

// clearNotifications is destructive, so what it scopes the delete to matters
// more than what it returns.

const state = {}
vi.mock('./supabase', () => ({
  sb: {
    from: table => {
      state.table = table
      const chain = {
        delete: () => { state.deleted = true; return chain },
        eq: (col, val) => { state.eq = [col, val]; (state.eqs ||= []).push([col, val]); return chain },
        lt: (col, val) => { state.lt = [col, val]; return chain },
        select: () => Promise.resolve({ data: [], error: null, count: 3 }),
        then: (res) => res({ error: null }),
      }
      return chain
    },
  },
}))

const { clearNotifications, deleteNotification } = await import('./community')

describe('clearNotifications', () => {
  beforeEach(() => { for (const k of Object.keys(state)) delete state[k] })

  it('scopes the delete to the caller even though RLS already does', () => {
    // Belt and braces on purpose: a misconfigured policy must not be able to
    // turn this button into a global wipe.
    clearNotifications('user-1')
    expect(state.table).toBe('notifications')
    expect(state.deleted).toBe(true)
    expect(state.eq).toEqual(['user_id', 'user-1'])
  })

  it('clears everything when no cutoff is given', () => {
    clearNotifications('user-1')
    expect(state.lt).toBeUndefined()
  })

  it('clears only older rows when given a cutoff', () => {
    clearNotifications('user-1', { before: '2026-09-01T00:00:00Z' })
    expect(state.lt).toEqual(['created_at', '2026-09-01T00:00:00Z'])
  })

  it('does nothing without a user, rather than deleting unscoped', () => {
    expect(clearNotifications(null)).resolves.toBe(0)
    expect(state.deleted).toBeUndefined()
  })

  it('reports how many rows went', async () => {
    expect(await clearNotifications('user-1')).toBe(3)
  })
})

describe('deleteNotification', () => {
  beforeEach(() => { for (const k of Object.keys(state)) delete state[k] })

  it('scopes a single dismiss to the caller and the row', async () => {
    await deleteNotification('user-1', 'note-9')
    expect(state.table).toBe('notifications')
    expect(state.deleted).toBe(true)
    expect(state.eqs).toEqual([['user_id', 'user-1'], ['id', 'note-9']])
  })

  it('does nothing without both a user and a row', async () => {
    await deleteNotification(null, 'note-9')
    expect(state.deleted).toBeUndefined()
    await deleteNotification('user-1', null)
    expect(state.deleted).toBeUndefined()
  })
})
