// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCardDetailNav, useVisibleOrder } from './useCardDetailNav'

describe('useVisibleOrder', () => {
  it('keeps the previous array when the reported keys are unchanged', () => {
    const { result } = renderHook(() => useVisibleOrder())

    act(() => result.current[1](['a', 'b', 'c']))
    const first = result.current[0]
    expect(first).toEqual(['a', 'b', 'c'])

    // A browser that rebuilds its card array every render reports an equal but
    // fresh array — this must not produce a new state value, or the
    // report → setState → render cycle never settles.
    act(() => result.current[1](['a', 'b', 'c']))
    expect(result.current[0]).toBe(first)

    act(() => result.current[1](['a', 'c']))
    expect(result.current[0]).toEqual(['a', 'c'])
  })
})

describe('useCardDetailNav', () => {
  const ORDER = ['a', 'b', 'c']

  it('reports the position of the open card', () => {
    const { result } = renderHook(() => useCardDetailNav(ORDER, 'b', vi.fn()))
    expect(result.current.navIndex).toBe(1)
    expect(result.current.navTotal).toBe(3)
  })

  it('steps to the neighbouring key in either direction', () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() => useCardDetailNav(ORDER, 'b', onSelect))

    act(() => result.current.onNavigate(1))
    expect(onSelect).toHaveBeenCalledWith('c')

    act(() => result.current.onNavigate(-1))
    expect(onSelect).toHaveBeenLastCalledWith('a')
  })

  it('does nothing past either end of the list', () => {
    const onSelect = vi.fn()
    const first = renderHook(() => useCardDetailNav(ORDER, 'a', onSelect))
    act(() => first.result.current.onNavigate(-1))

    const last = renderHook(() => useCardDetailNav(ORDER, 'c', onSelect))
    act(() => last.result.current.onNavigate(1))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('reports no position for a card that is not in the list', () => {
    const onSelect = vi.fn()
    // e.g. a combo suggestion opened by name in DeckView, or a card filtered
    // out after the modal was opened.
    const { result } = renderHook(() => useCardDetailNav(ORDER, 'zzz', onSelect))
    expect(result.current.navIndex).toBe(-1)

    act(() => result.current.onNavigate(1))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
