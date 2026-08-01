import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertOnline,
  createOfflineError,
  isNetworkLikeError,
  isOfflineError,
} from './networkUtils'

// Matches collectionFetchers.test.js — the node test env has a `navigator`
// global but no spy-able `onLine` property to override.
function setOnline(value) {
  vi.stubGlobal('navigator', { onLine: value })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('assertOnline', () => {
  it('passes through when the browser reports a connection', () => {
    setOnline(true)
    expect(() => assertOnline()).not.toThrow()
  })

  it('throws a recognisable OfflineError when offline', () => {
    setOnline(false)
    let thrown = null
    try { assertOnline() } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(Error)
    expect(isOfflineError(thrown)).toBe(true)
  })

  it('carries a caller-supplied message so the UI can show it verbatim', () => {
    setOnline(false)
    // DeckBuilder's auto-fill relies on this: the assistant renders the message
    // as its own banner text rather than prefixing it.
    expect(() => assertOnline('Auto-fill needs a connection.'))
      .toThrow('Auto-fill needs a connection.')
  })
})

describe('isOfflineError', () => {
  it('recognises only the tagged offline error', () => {
    expect(isOfflineError(createOfflineError())).toBe(true)
    expect(isOfflineError(new Error('Failed to fetch'))).toBe(false)
    expect(isOfflineError(null)).toBe(false)
  })

  it('is narrower than isNetworkLikeError', () => {
    setOnline(true)
    const fetchFailure = new Error('Failed to fetch')
    // A dropped request while nominally online is network-like but not offline:
    // retrying it is reasonable, whereas an offline error should not be retried.
    expect(isNetworkLikeError(fetchFailure)).toBe(true)
    expect(isOfflineError(fetchFailure)).toBe(false)
  })
})
