// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/deckBuilderApi', () => ({
  searchCards: vi.fn(),
  makeDebouncer: (ms = 0) => {
    let timer
    return fn => {
      clearTimeout(timer)
      timer = setTimeout(fn, ms)
    }
  },
}))

import { searchCards } from '../lib/deckBuilderApi'
import { useCardSearch } from './useCardSearch'

describe('useCardSearch', () => {
  beforeEach(() => {
    searchCards.mockReset()
  })

  it('clears the previous query results before an empty search completes', async () => {
    searchCards
      .mockResolvedValueOnce({
        cards: [{ id: 'sol-ring', name: 'Sol Ring' }],
        hasMore: false,
      })
      .mockResolvedValueOnce({ cards: [], hasMore: false })

    const { result } = renderHook(() => useCardSearch({ debounceMs: 0 }))

    act(() => result.current.handleInput('sol'))
    await waitFor(() => expect(result.current.results).toHaveLength(1))

    act(() => result.current.handleInput('definitely-not-a-card'))

    expect(result.current.results).toEqual([])
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.query).toBe('definitely-not-a-card')
    expect(result.current.results).toEqual([])
    expect(result.current.hasMore).toBe(false)
  })
})
