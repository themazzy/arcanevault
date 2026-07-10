import { describe, it, expect, vi } from 'vitest'
import { beginActivity, trackActivity, subscribeActivity, getActivityCount } from './activity.js'

describe('beginActivity', () => {
  it('increments the count and releases back down', () => {
    const base = getActivityCount()
    const end = beginActivity()
    expect(getActivityCount()).toBe(base + 1)
    end()
    expect(getActivityCount()).toBe(base)
  })

  it('release is idempotent — double call cannot underflow', () => {
    const base = getActivityCount()
    const end = beginActivity()
    end()
    end()
    expect(getActivityCount()).toBe(base)
  })

  it('supports overlapping activities', () => {
    const base = getActivityCount()
    const endA = beginActivity()
    const endB = beginActivity()
    expect(getActivityCount()).toBe(base + 2)
    endA()
    expect(getActivityCount()).toBe(base + 1)
    endB()
    expect(getActivityCount()).toBe(base)
  })
})

describe('trackActivity', () => {
  it('counts while a promise is pending and resolves with its value', async () => {
    const base = getActivityCount()
    let resolve
    const pending = new Promise(r => { resolve = r })
    const tracked = trackActivity(pending)
    expect(getActivityCount()).toBe(base + 1)
    resolve('done')
    await expect(tracked).resolves.toBe('done')
    expect(getActivityCount()).toBe(base)
  })

  it('releases the counter when the promise rejects', async () => {
    const base = getActivityCount()
    await expect(trackActivity(Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(getActivityCount()).toBe(base)
  })

  it('accepts a function returning a promise', async () => {
    const base = getActivityCount()
    const result = await trackActivity(() => Promise.resolve(42))
    expect(result).toBe(42)
    expect(getActivityCount()).toBe(base)
  })

  it('releases even when the function throws synchronously', async () => {
    const base = getActivityCount()
    await expect(trackActivity(() => { throw new Error('sync boom') })).rejects.toThrow('sync boom')
    expect(getActivityCount()).toBe(base)
  })
})

describe('subscribeActivity', () => {
  it('notifies on begin and release, and stops after unsubscribe', () => {
    const seen = []
    const unsubscribe = subscribeActivity(c => seen.push(c))
    const base = getActivityCount()
    const end = beginActivity()
    end()
    expect(seen).toEqual([base + 1, base])
    unsubscribe()
    const end2 = beginActivity()
    end2()
    expect(seen).toEqual([base + 1, base])
  })

  it('a throwing listener does not break other listeners', () => {
    const good = vi.fn()
    const unsubBad = subscribeActivity(() => { throw new Error('listener boom') })
    const unsubGood = subscribeActivity(good)
    const end = beginActivity()
    end()
    expect(good).toHaveBeenCalledTimes(2)
    unsubBad(); unsubGood()
  })
})
