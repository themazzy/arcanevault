import { describe, expect, it } from 'vitest'
import {
  VIEW_DEDUPE_TTL_S,
  buildViewDedupeKey,
  shouldCountDeckView,
} from '../../cloudflare/og-worker/deckViews.js'

describe('shouldCountDeckView', () => {
  const browser = {
    method: 'GET',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126',
    isCrawlerUa: false,
  }

  it('counts a normal browser GET', () => {
    expect(shouldCountDeckView(browser)).toBe(true)
  })

  it('does not count crawlers — an unfurl is not a reader', () => {
    expect(shouldCountDeckView({ ...browser, isCrawlerUa: true })).toBe(false)
  })

  it('does not count non-GET requests', () => {
    expect(shouldCountDeckView({ ...browser, method: 'HEAD' })).toBe(false)
    expect(shouldCountDeckView({ ...browser, method: 'POST' })).toBe(false)
  })

  it('does not count a request with no user agent', () => {
    expect(shouldCountDeckView({ ...browser, userAgent: null })).toBe(false)
    expect(shouldCountDeckView({ ...browser, userAgent: '' })).toBe(false)
  })
})

describe('buildViewDedupeKey', () => {
  it('produces an absolute URL, as the Cache API requires', () => {
    const key = buildViewDedupeKey('abc-123', 'deadbeef')
    expect(() => new URL(key)).not.toThrow()
    expect(key.startsWith('https://')).toBe(true)
  })

  it('separates decks and clients', () => {
    expect(buildViewDedupeKey('deck-a', 'client-1')).not.toBe(buildViewDedupeKey('deck-b', 'client-1'))
    expect(buildViewDedupeKey('deck-a', 'client-1')).not.toBe(buildViewDedupeKey('deck-a', 'client-2'))
  })

  it('is stable for the same deck and client', () => {
    expect(buildViewDedupeKey('deck-a', 'client-1')).toBe(buildViewDedupeKey('deck-a', 'client-1'))
  })

  it('escapes a deck id so it cannot alter the key path', () => {
    const key = buildViewDedupeKey('a/../b', 'client-1')
    expect(key).not.toContain('/../')
  })

  it('dedupes for hours, not seconds — a reload must not recount', () => {
    expect(VIEW_DEDUPE_TTL_S).toBeGreaterThanOrEqual(60 * 60)
  })
})
