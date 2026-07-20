import { describe, expect, it } from 'vitest'
import {
  CARD_GRID_DENSITY,
  GRID_IMG_BORDER_PX,
  getDesktopCardGridMetrics,
  gridColumnsForDensity,
} from './cardGridDensity'

describe('shared card grid density', () => {
  it('keeps each density anchored to its intended image width', () => {
    for (const [density, spec] of Object.entries(CARD_GRID_DENSITY)) {
      const targetWidth = spec.px + GRID_IMG_BORDER_PX
      const metrics = getDesktopCardGridMetrics(targetWidth * 8 + spec.desktopGap * 7, density)
      expect(metrics.imageWidth).toBe(spec.px)
      expect(metrics.columnGap).toBe(spec.desktopGap)
    }
  })

  it('preserves the intended wide-screen row counts after scrollbar width', () => {
    expect(getDesktopCardGridMetrics(1502, 'cozy').columns).toBe(6)
    expect(getDesktopCardGridMetrics(1502, 'comfortable').columns).toBe(10)
    expect(getDesktopCardGridMetrics(1502, 'compact').columns).toBe(12)
  })

  it('uses the same initial column target as the CSS fallback grid', () => {
    for (const [density, spec] of Object.entries(CARD_GRID_DENSITY)) {
      expect(gridColumnsForDensity(density)).toContain(`${spec.px + GRID_IMG_BORDER_PX}px`)
    }
  })

  it('scales cards slightly to fill intermediate viewport widths', () => {
    const metrics = getDesktopCardGridMetrics(1192, 'comfortable')
    expect(metrics.columns).toBe(8)
    expect(metrics.columnWidth).toBeCloseTo(147.25)
    expect(metrics.columns * metrics.columnWidth + (metrics.columns - 1) * metrics.columnGap)
      .toBeCloseTo(1192)
  })

  it('fills every tested desktop width without a trailing card-sized gap', () => {
    for (const width of [431, 600, 800, 1000, 1192, 1300, 1502]) {
      for (const density of Object.keys(CARD_GRID_DENSITY)) {
        const metrics = getDesktopCardGridMetrics(width, density)
        const usedWidth = metrics.columns * metrics.columnWidth
          + (metrics.columns - 1) * metrics.columnGap
        expect(usedWidth).toBeCloseTo(width)
      }
    }
  })
})
