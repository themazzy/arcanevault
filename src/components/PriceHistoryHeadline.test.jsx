// @vitest-environment jsdom

import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PriceHistoryChart from './PriceHistoryChart'

// The headline is the readout: hovering retargets the big number to the day
// under the cursor. It used to be echoed below the plot as well, so the price
// moved in two places at once and neither was obviously the one to read.
//
// It is also the only place an interpolated day is disclosed — bridgeShortGaps
// has flagged those since it was written, and nothing displayed the flag.

const ROW = {
  start_date: '2026-09-01',
  // Day 3 is a one-day hole, so bridgeShortGaps interpolates it to 12 and marks
  // it `estimated` — the case the chart has to own up to.
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
  fireEvent.mouseMove(plot, { clientX: 52 + (index / 4) * (600 - 52 - 14) })
}

function unhover() {
  fireEvent.mouseLeave(document.querySelector('figure > div'))
}

describe('price history headline', () => {
  beforeEach(setup)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('shows the latest price and the whole-window change at rest', async () => {
    await renderChart()
    expect(screen.getByText('€14.00')).toBeTruthy()
    expect(screen.getByText(/over 5 days/)).toBeTruthy()
  })

  it('retargets the headline price to the hovered day', async () => {
    await renderChart()
    hoverIndex(1)
    expect(screen.getByText('€11.00')).toBeTruthy()
    expect(screen.queryByText('€14.00')).toBe(null)
  })

  it('names the hovered day, with its weekday, beside the source', async () => {
    await renderChart()
    hoverIndex(1)                       // 2026-09-02 is a Wednesday
    expect(screen.getByText(/Wed 2 Sep/)).toBeTruthy()
  })

  it('reports the change against the day before, not the window start', async () => {
    await renderChart()
    hoverIndex(1)
    expect(screen.getByText(/▲ €1\.00 \(\+10\.0%\)/)).toBeTruthy()
    expect(screen.getByText(/vs day before/)).toBeTruthy()
  })

  it('discloses an interpolated day instead of passing it off as a quote', async () => {
    await renderChart()
    hoverIndex(2)
    expect(screen.getByText('estimated')).toBeTruthy()
  })

  it('says nothing about estimation on a genuinely quoted day', async () => {
    await renderChart()
    hoverIndex(3)
    expect(screen.queryByText('estimated')).toBe(null)
  })

  it('returns to the latest price when the cursor leaves', async () => {
    await renderChart()
    hoverIndex(1)
    expect(screen.getByText('€11.00')).toBeTruthy()
    unhover()
    expect(screen.getByText('€14.00')).toBeTruthy()
    expect(screen.getByText(/over 5 days/)).toBeTruthy()
  })

  it('keeps the range below the plot static while hovering', async () => {
    // It was the hover target too, which meant two live numbers competing.
    await renderChart()
    const range = screen.getByText('€10.00 – €14.00')
    hoverIndex(1)
    expect(screen.getByText('€10.00 – €14.00')).toBe(range)
    expect(screen.getByText(/5-day range/)).toBeTruthy()
  })
})
