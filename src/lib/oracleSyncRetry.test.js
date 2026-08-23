import { describe, it, expect } from 'vitest'
import { isRetryableWriteError, upsertWithRetry } from '../../scripts/sync-oracle-cards.mjs'

// The weekly oracle sync died on `canceling statement due to statement timeout`
// partway through its upserts, abandoning every remaining row until the next
// Sunday. oracle_cards has three GIN indexes, so a large batch is genuinely
// expensive to write; these guard the two halves of the fix — recognising the
// cancellation as transient, and shrinking the statement that caused it.

const rows = n => Array.from({ length: n }, (_, i) => ({ oracle_id: String(i) }))
const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }

describe('isRetryableWriteError', () => {
  it('recognises a statement timeout by SQLSTATE', () => {
    expect(isRetryableWriteError(timeout)).toBe(true)
    expect(isRetryableWriteError({ code: '57014', message: '' })).toBe(true)
  })

  it('recognises one by message when no code came through', () => {
    expect(isRetryableWriteError({ message: 'canceling statement due to statement timeout' })).toBe(true)
    expect(isRetryableWriteError({ message: 'deadlock detected' })).toBe(true)
  })

  it('recognises dropped connections, which are safe to repeat on an idempotent upsert', () => {
    for (const message of ['fetch failed', 'socket hang up', 'read ECONNRESET', 'getaddrinfo EAI_AGAIN db.host']) {
      expect(isRetryableWriteError({ message })).toBe(true)
    }
  })

  it('does not retry a genuine data error', () => {
    // Repeating a constraint violation just fails again, slower.
    expect(isRetryableWriteError({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false)
    expect(isRetryableWriteError({ code: '42703', message: 'column "nope" does not exist' })).toBe(false)
    expect(isRetryableWriteError(null)).toBe(false)
  })
})

describe('upsertWithRetry', () => {
  const noWait = async () => {}

  it('writes once when the batch succeeds', async () => {
    const calls = []
    await upsertWithRetry(rows(100), batch => { calls.push(batch.length); return { error: null } }, { wait: noWait })
    expect(calls).toEqual([100])
  })

  it('does nothing on an empty batch', async () => {
    let called = false
    await upsertWithRetry([], () => { called = true; return { error: null } }, { wait: noWait })
    expect(called).toBe(false)
  })

  it('halves a timing-out batch and still writes every row exactly once', async () => {
    const written = []
    const sizes = []
    await upsertWithRetry(rows(100), batch => {
      sizes.push(batch.length)
      // Stands in for the statement being too expensive above some size.
      if (batch.length > 30) return { error: timeout }
      written.push(...batch.map(r => r.oracle_id))
      return { error: null }
    }, { minBatch: 25, wait: noWait })

    expect(written.sort((a, b) => a - b)).toEqual(rows(100).map(r => r.oracle_id).sort((a, b) => a - b))
    expect(Math.max(...sizes.filter(s => s <= 30))).toBeLessThanOrEqual(30)
  })

  it('backs off with growing delays once the batch is too small to split', async () => {
    const delays = []
    let attempts = 0
    await upsertWithRetry(rows(25), () => {
      attempts++
      return { error: attempts < 3 ? timeout : null }
    }, { minBatch: 25, wait: async ms => { delays.push(ms) } })

    expect(attempts).toBe(3)
    expect(delays).toEqual([1000, 2000])
  })

  it('gives up after the attempt budget so a dead instance fails the job loudly', async () => {
    let attempts = 0
    await expect(upsertWithRetry(rows(10), () => { attempts++; return { error: timeout } }, { wait: noWait }))
      .rejects.toMatchObject({ code: '57014' })
    expect(attempts).toBe(4)
  })

  it('throws a non-retryable error immediately, without splitting', async () => {
    const sizes = []
    const bad = { code: '23502', message: 'null value in column "name" violates not-null constraint' }
    await expect(upsertWithRetry(rows(100), batch => { sizes.push(batch.length); return { error: bad } }, { wait: noWait }))
      .rejects.toMatchObject({ code: '23502' })
    expect(sizes).toEqual([100])
  })
})
