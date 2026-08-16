import { describe, it, expect, vi } from 'vitest'
import { runWithConcurrency, withRetry } from './concurrency'

describe('runWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    // Reversed delays: the last item finishes first. Results must still line up
    // with the inputs, since callers merge them positionally.
    const items = [40, 30, 20, 10]
    const out = await runWithConcurrency(items, 2, async (ms) => {
      await new Promise(r => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([40, 30, 20, 10])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(4)
  })

  it('handles an empty list without spawning lanes', async () => {
    const worker = vi.fn()
    expect(await runWithConcurrency([], 4, worker)).toEqual([])
    expect(worker).not.toHaveBeenCalled()
  })

  it('propagates a worker rejection', async () => {
    await expect(runWithConcurrency([1, 2], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })).rejects.toThrow('boom')
  })
})

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn, { baseDelayMs: 0 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('recovers from a transient failure', async () => {
    // The case this exists for: one bad batch out of many must not abort the
    // run and send every card to the rate-limited Scryfall fallback.
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue('ok')
    expect(await withRetry(fn, { baseDelayMs: 0 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('still down'))
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow('still down')
    // attempts is total tries, not extra tries.
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry when shouldRetry rejects the error', async () => {
    // A deterministic failure (bad column, schema drift) gains nothing from
    // retrying and just delays the fallback.
    const fn = vi.fn().mockRejectedValue(new Error('column does not exist'))
    await expect(
      withRetry(fn, { baseDelayMs: 0, shouldRetry: err => !err.message.includes('column') }),
    ).rejects.toThrow('column does not exist')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('composes with runWithConcurrency so one flaky item does not abort the run', async () => {
    const attempts = new Map()
    const out = await runWithConcurrency([1, 2, 3, 4], 2, item =>
      withRetry(async () => {
        const n = (attempts.get(item) || 0) + 1
        attempts.set(item, n)
        if (item === 3 && n === 1) throw new Error('transient')
        return item * 10
      }, { baseDelayMs: 0 }),
    )
    expect(out).toEqual([10, 20, 30, 40])
    expect(attempts.get(3)).toBe(2)
  })
})
