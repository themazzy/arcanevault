// @vitest-environment jsdom

import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PriceHistoryChart from './PriceHistoryChart'

// The hover readout is the only place a single day's price is legible, and the
// only place an interpolated day is disclosed. "€71.19 · 7 Sep" said neither
// what the number was nor whether anyone had actually quoted it.

const ROW = {
  start_date: '2026-09-01',
  // Day 3 is a one-day hole, so bridgeShortGaps interpolates it to 12 and flags
  // it `estimated` — the case the readout has to own up to.
  prices_eur: [10, 11, null, 13, 14],
  prices_foil_eur: null,
  prices_usd: null,
  prices_usd_foil: null,
}

vi.mock('../lib/supabase', () => ({
  sb: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: ROW, error: null }) }) }),
    }),
  },
}))

// The chart measures its wrapper; jsdom reports 0, so pin a real width and a
// stable box for the hover maths.
function setup() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 600 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: 600, height: 168, right: 600, bottom: 168, x: 0, y: 0, toJSON() {} }
  }
}

async function renderChart() {
  render(<PriceHistoryChart scryfallId="sid-1" />)
  return screen.findByText(/day range/i)
}

/** Plot spans x = 52..586 over 5 points; this lands on the given index. */
function hoverIndex(index) {
  const plot = document.querySelector('figure > div')
  const x = 52 + (index / 4) * (600 - 52 - 14)
  fireEvent.mouseMove(plot, { clientX: x })
}

describe('price history readout', () => {
  beforeEach(setup)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('labels the resting state with the period, not a bare pair of numbers', async () => {
    await renderChart()
    expect(screen.getByText(/5-day range/)).toBeTruthy()
    expect(screen.getByText('€10.00 – €14.00')).toBeTruthy()
  })

  it('names the day, with its weekday, when hovering a point', async () => {
    await renderChart()
    hoverIndex(1)          // 2026-09-02 is a Wednesday
    expect(screen.getByText('Wed 2 Sep')).toBeTruthy()
    expect(screen.getByText('€11.00')).toBeTruthy()
  })

  it('reports the change against the day before, not against the window start', async () => {
    await renderChart()
    hoverIndex(1)
    expect(screen.getByText(/▲ €1\.00 \(\+10\.0%\) from the day before/)).toBeTruthy()
  })

  it('discloses an interpolated day instead of passing it off as a quote', async () => {
    // The whole point: a filled gap is our plumbing, not the market.
    await renderChart()
    hoverIndex(2)
    expect(screen.getByText(/estimated — no price published that day/)).toBeTruthy()
  })

  it('says nothing about estimation on a genuinely quoted day', async () => {
    await renderChart()
    hoverIndex(3)
    expect(screen.queryByText(/estimated/)).toBe(null)
  })
})
