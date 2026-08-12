// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLEARANCE_VAR,
  resolveClearance,
  useBottomBarClearance,
  __resetClearanceClaims,
  MOBILE_TOOLBAR_HEIGHT,
  BULK_BAR_HEIGHT,
  SCANNER_BAR_HEIGHT,
} from './bottomBarClearance'

const clearance = () => document.documentElement.style.getPropertyValue(CLEARANCE_VAR)

// jsdom has no layout, so matchMedia is stubbed per test to say whether the
// bar's breakpoint is in force.
function stubMatchMedia(matches) {
  const listeners = new Set()
  const handle = {
    matches,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  }
  window.matchMedia = vi.fn(() => handle)
  return {
    // Resize the viewport across the bar's breakpoint.
    set(next) { handle.matches = next; listeners.forEach(fn => fn()) },
  }
}

function Bar(props) {
  useBottomBarClearance(props)
  return null
}

beforeEach(() => { stubMatchMedia(true) })
afterEach(() => { cleanup(); __resetClearanceClaims() })

describe('resolveClearance', () => {
  it('reserves nothing when no bar is mounted', () => {
    expect(resolveClearance([])).toBeNull()
    expect(resolveClearance(null)).toBeNull()
  })

  it('passes a single claim straight through', () => {
    expect(resolveClearance(['var(--a)'])).toBe('var(--a)')
  })

  it('lets the tallest bar win via CSS max(), since JS cannot compare tokens', () => {
    // A browse surface can show its toolbar and the bulk bar together.
    expect(resolveClearance(['var(--a)', 'var(--b)'])).toBe('max(var(--a), var(--b))')
  })

  it('collapses duplicate claims rather than emitting max(x, x)', () => {
    expect(resolveClearance(['var(--a)', 'var(--a)'])).toBe('var(--a)')
  })

  it('is order-independent so remounting does not churn the style attribute', () => {
    expect(resolveClearance(['var(--b)', 'var(--a)'])).toBe(resolveClearance(['var(--a)', 'var(--b)']))
  })
})

describe('useBottomBarClearance', () => {
  it('reserves the bar height while mounted and releases it on unmount', () => {
    const view = render(<Bar height={MOBILE_TOOLBAR_HEIGHT} query="(max-width: 980px)" />)
    expect(clearance()).toBe(MOBILE_TOOLBAR_HEIGHT)
    view.unmount()
    expect(clearance()).toBe('')
  })

  it('reserves nothing while the bar is not rendered', () => {
    render(<Bar active={false} height={MOBILE_TOOLBAR_HEIGHT} query="(max-width: 980px)" />)
    expect(clearance()).toBe('')
  })

  it('reserves nothing above the breakpoint where the bar is not pinned', () => {
    stubMatchMedia(false)
    render(<Bar height={MOBILE_TOOLBAR_HEIGHT} query="(max-width: 980px)" />)
    expect(clearance()).toBe('')
  })

  it('claims unconditionally when the bar has no breakpoint', () => {
    // The scanner is full-screen at every width, tablets included.
    stubMatchMedia(false)
    render(<Bar height={SCANNER_BAR_HEIGHT} />)
    expect(clearance()).toBe(SCANNER_BAR_HEIGHT)
  })

  it('follows the viewport across the breakpoint without a remount', () => {
    const mq = stubMatchMedia(false)
    render(<Bar height={MOBILE_TOOLBAR_HEIGHT} query="(max-width: 980px)" />)
    expect(clearance()).toBe('')

    mq.set(true)
    expect(clearance()).toBe(MOBILE_TOOLBAR_HEIGHT)

    mq.set(false)
    expect(clearance()).toBe('')
  })

  it('keeps the reservation while a second bar is still mounted', () => {
    const toolbar = render(<Bar height={MOBILE_TOOLBAR_HEIGHT} query="(max-width: 980px)" />)
    render(<Bar height={BULK_BAR_HEIGHT} query="(max-width: 620px)" />)
    expect(clearance()).toBe(`max(${[MOBILE_TOOLBAR_HEIGHT, BULK_BAR_HEIGHT].sort().join(', ')})`)

    toolbar.unmount()
    expect(clearance()).toBe(BULK_BAR_HEIGHT)
  })
})
