import { describe, expect, it } from 'vitest'
import { isCurrentManualSearchRequest } from './manualSearchRequest'

describe('isCurrentManualSearchRequest', () => {
  it('accepts the latest request while the scanner is mounted', () => {
    expect(isCurrentManualSearchRequest({ mounted: true, activeRequestId: 4, requestId: 4 })).toBe(true)
  })

  it('rejects stale requests', () => {
    expect(isCurrentManualSearchRequest({ mounted: true, activeRequestId: 5, requestId: 4 })).toBe(false)
  })

  it('rejects results after unmount', () => {
    expect(isCurrentManualSearchRequest({ mounted: false, activeRequestId: 4, requestId: 4 })).toBe(false)
  })
})
