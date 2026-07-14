import { describe, expect, it } from 'vitest'
import {
  boardForCard,
  formatAttractionLights,
  getAttractionDeckWarnings,
  isAttractionCard,
} from './attractions'

const balloon = {
  id: 'balloon-200d',
  name: 'Balloon Stand',
  type_line: 'Artifact — Attraction',
  set_code: 'unf',
  collector_number: '200d',
  attraction_lights: [5, 6],
}

describe('Attraction helpers', () => {
  it('recognizes Attractions and preserves their print-specific lit numbers', () => {
    expect(isAttractionCard(balloon)).toBe(true)
    expect(formatAttractionLights(balloon)).toBe('5, 6')
  })

  it('routes Attractions to the supplementary board except from maybeboard', () => {
    expect(boardForCard(balloon, null, 'main')).toBe('attraction')
    expect(boardForCard(balloon, null, 'side')).toBe('attraction')
    expect(boardForCard(balloon, null, 'maybe')).toBe('maybe')
    expect(boardForCard({ type_line: 'Artifact' }, null, 'attraction')).toBe('main')
  })

  it('enforces constructed size and English-name uniqueness', () => {
    const warnings = getAttractionDeckWarnings([
      { ...balloon, board: 'attraction', qty: 2 },
    ])
    expect(warnings.map(w => w.key)).toContain('attraction-size')
    expect(warnings.map(w => w.key)).toContain('attraction-duplicate:balloon stand')
  })
})
