// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HomeSkeleton } from './Home'

afterEach(cleanup)

describe('HomeSkeleton', () => {
  // The old holding state hid itself for 180ms to avoid flashing a branded
  // splash. A skeleton is the shape of the content it replaces, so it should
  // appear straight away — a delay would turn a short wait into a flash.
  it('renders its placeholder blocks immediately', () => {
    const { container } = render(<HomeSkeleton />)

    expect(container.firstChild.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelectorAll('[class*="skel"]').length).toBeGreaterThan(0)
  })

  it('announces the loading state without exposing the placeholder blocks', () => {
    const { container } = render(<HomeSkeleton />)

    expect(screen.getByRole('status').textContent).toBe('Loading your home')
    // Every decorative region is hidden from assistive tech, so a screen reader
    // hears one message rather than a run of empty regions.
    const decorative = [...container.firstChild.children].filter(el => el.getAttribute('role') !== 'status')
    expect(decorative.length).toBeGreaterThan(0)
    expect(decorative.every(el => el.getAttribute('aria-hidden') === 'true')).toBe(true)
  })
})
