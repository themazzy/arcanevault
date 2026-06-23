import { describe, it, expect } from 'vitest'
import { isNudgeEligible, MIN_ACCOUNT_AGE_DAYS } from './FeedbackNudge.jsx'

const NOW = Date.parse('2026-06-23T12:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

describe('isNudgeEligible', () => {
  it('shows for an account older than the threshold', () => {
    expect(isNudgeEligible({ createdAt: daysAgo(MIN_ACCOUNT_AGE_DAYS + 1), dismissed: false, now: NOW })).toBe(true)
  })

  it('hides for a brand-new account', () => {
    expect(isNudgeEligible({ createdAt: daysAgo(1), dismissed: false, now: NOW })).toBe(false)
  })

  it('is inclusive exactly at the threshold', () => {
    expect(isNudgeEligible({ createdAt: daysAgo(MIN_ACCOUNT_AGE_DAYS), dismissed: false, now: NOW })).toBe(true)
  })

  it('hides once dismissed regardless of age', () => {
    expect(isNudgeEligible({ createdAt: daysAgo(365), dismissed: true, now: NOW })).toBe(false)
  })

  it('hides when there is no created_at', () => {
    expect(isNudgeEligible({ createdAt: undefined, dismissed: false, now: NOW })).toBe(false)
  })

  it('hides for an unparseable created_at', () => {
    expect(isNudgeEligible({ createdAt: 'not-a-date', dismissed: false, now: NOW })).toBe(false)
  })
})
