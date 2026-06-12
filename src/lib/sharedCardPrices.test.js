import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase', () => ({ sb: {} }))
vi.mock('./db', () => ({
  getLocalCardPriceRowsByIds: vi.fn(),
  getLocalCardPriceRowsBySetCodes: vi.fn(),
  putCardPriceRows: vi.fn(),
}))
vi.mock('./scryfall', () => ({
  enrichCards: vi.fn(),
  getInstantCache: vi.fn(),
}))

import { runWithConcurrency } from './sharedCardPrices'

describe('runWithConcurrency', () => {
  it('returns results in input order', async () => {
    const items = [30, 10, 20]
    const results = await runWithConcurrency(items, 2, async (ms) => {
      await new Promise(r => setTimeout(r, ms))
      return ms * 2
    })
    expect(results).toEqual([60, 20, 40])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight -= 1
    })
    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('handles empty input and propagates worker errors', async () => {
    expect(await runWithConcurrency([], 4, async () => 1)).toEqual([])
    await expect(
      runWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
  })
})
