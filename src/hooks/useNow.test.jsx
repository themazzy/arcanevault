// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNow } from './useNow'

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('provides a stable render snapshot and advances outside render', () => {
    const { result } = renderHook(() => useNow())
    expect(result.current).toBe(Date.parse('2026-01-01T00:00:00Z'))

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(result.current).toBe(Date.parse('2026-01-01T00:00:01Z'))
  })

  it('uses minute updates for low-frequency displays', () => {
    const { result } = renderHook(() => useNow(60000))
    const initial = result.current

    act(() => {
      vi.advanceTimersByTime(59000)
    })
    expect(result.current).toBe(initial)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(initial + 60000)
  })
})
