// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLongPress } from './useLongPress'

afterEach(() => {
  vi.useRealTimers()
})

describe('useLongPress', () => {
  it('reports a completed long press exactly once to the following click', () => {
    vi.useFakeTimers()
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress(onLongPress, { delay: 500 }))
    const event = {
      type: 'mousedown',
      button: 0,
      cancelable: true,
      preventDefault: vi.fn(),
    }

    act(() => {
      result.current.onMouseDown(event)
      vi.advanceTimersByTime(500)
    })

    expect(onLongPress).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(result.current.consumeFired()).toBe(true)
    expect(result.current.consumeFired()).toBe(false)
  })

  it('does not suppress a click when the press ends before the delay', () => {
    vi.useFakeTimers()
    const onLongPress = vi.fn()
    const { result } = renderHook(() => useLongPress(onLongPress, { delay: 500 }))
    const event = { type: 'mousedown', button: 0 }

    act(() => {
      result.current.onMouseDown(event)
      result.current.onMouseUp()
      vi.advanceTimersByTime(500)
    })

    expect(onLongPress).not.toHaveBeenCalled()
    expect(result.current.consumeFired()).toBe(false)
  })
})
