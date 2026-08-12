// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useGuidedDeckName } from './useGuidedDeckName'

afterEach(cleanup)

describe('useGuidedDeckName', () => {
  it('fills the name in from the first commander picked', () => {
    const { result } = renderHook(() => useGuidedDeckName())
    act(() => result.current.syncToCommander('Krenko, Mob Boss'))
    expect(result.current.name).toBe('Krenko, Mob Boss')
  })

  // The bug this hook was extracted for. Rolling a random commander twice left
  // the deck named after the FIRST roll while being built for the second:
  // "Frodo Baggins" on a Rasaad yn Bashir + Guild Artisan deck. The updater ran
  // during the next render, by which point the ref already held the new name,
  // so the comparison always said "the user typed this".
  it('replaces an auto-filled name on every later pick, not just the first', () => {
    const { result } = renderHook(() => useGuidedDeckName())

    act(() => result.current.syncToCommander('Frodo Baggins'))
    act(() => result.current.syncToCommander('Rasaad yn Bashir'))
    expect(result.current.name).toBe('Rasaad yn Bashir')

    act(() => result.current.syncToCommander('Atraxa, Praetors\' Voice'))
    expect(result.current.name).toBe('Atraxa, Praetors\' Voice')
  })

  it('never overwrites a name the user typed', () => {
    const { result } = renderHook(() => useGuidedDeckName())

    act(() => result.current.syncToCommander('Frodo Baggins'))
    act(() => result.current.setName('Hobbit Tribal'))
    act(() => result.current.syncToCommander('Rasaad yn Bashir'))

    expect(result.current.name).toBe('Hobbit Tribal')
  })

  it('treats a cleared field as free to fill again', () => {
    const { result } = renderHook(() => useGuidedDeckName())

    act(() => result.current.syncToCommander('Frodo Baggins'))
    act(() => result.current.setName('   '))
    act(() => result.current.syncToCommander('Rasaad yn Bashir'))

    expect(result.current.name).toBe('Rasaad yn Bashir')
  })

  // reset() has to clear the remembered auto-name too: without it the next
  // deck's first pick compares against the previous deck's commander and is
  // mistaken for something the user typed.
  it('forgets the previous deck after reset', () => {
    const { result } = renderHook(() => useGuidedDeckName())

    act(() => result.current.syncToCommander('Frodo Baggins'))
    act(() => result.current.reset())
    expect(result.current.name).toBe('')

    act(() => result.current.syncToCommander('Rasaad yn Bashir'))
    expect(result.current.name).toBe('Rasaad yn Bashir')
  })
})
