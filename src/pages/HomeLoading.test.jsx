// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeModeLoading } from './Home'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('HomeModeLoading', () => {
  it('stays visually quiet for fast account checks, then shows a neutral loading state', () => {
    vi.useFakeTimers()
    const { container } = render(<HomeModeLoading />)

    expect(container.firstChild.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('Preparing your home')).toBeNull()

    act(() => vi.advanceTimersByTime(179))
    expect(screen.queryByText('Preparing your home')).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('status').textContent).toContain('Preparing your home')
  })
})
