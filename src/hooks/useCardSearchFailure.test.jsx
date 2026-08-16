// @vitest-environment jsdom
//
// Failure path for the deck-builder search hook.
//
// searchCards() normally resolves with `{ error: true }` rather than throwing,
// because supabase-js turns a PostgREST error into a value. But it is not the
// only thing that can go wrong on that line: a fetch rejection (offline, DNS
// failure, aborted connection, a throw anywhere inside the enrichment merge)
// rejects the promise instead. useCardSearch awaits it with no try/catch, so
// a rejection skips setLoading(false) entirely.
//
// The symptom is not an error message — it is a spinner that never stops, on
// a panel whose RPC has already been measured timing out in production. That
// is worth a test even though the path is narrower than the plain error one.

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/deckBuilderApi', () => ({
  searchCards: vi.fn(),
  makeDebouncer: () => fn => fn(),
}))

import { searchCards } from '../lib/deckBuilderApi'
import { useCardSearch } from './useCardSearch'

describe('useCardSearch failure paths', () => {
  beforeEach(() => { searchCards.mockReset() })

  it('clears loading when the search rejects', async () => {
    searchCards.mockRejectedValue(new Error('Failed to fetch'))

    const { result } = renderHook(() => useCardSearch({ debounceMs: 0 }))

    await act(async () => { result.current.handleInput('bolt') })

    // A stuck spinner is the failure being guarded against: the panel would
    // show a loading state forever with no way for the user to tell that the
    // request is never coming back.
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.results).toEqual([])
  })

  it('surfaces the error flag when the search rejects', async () => {
    searchCards.mockRejectedValue(new Error('Failed to fetch'))

    const { result } = renderHook(() => useCardSearch({ debounceMs: 0 }))

    await act(async () => { result.current.handleInput('bolt') })

    await waitFor(() => expect(result.current.loading).toBe(false))
    // Without this the UI renders an empty-state that reads as "no such card"
    // when the truth is that the request never completed.
    expect(result.current.error).toBe(true)
  })
})
