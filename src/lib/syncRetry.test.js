import { describe, it, expect } from 'vitest'
import {
  isRetryableError,
  isOversizedStatementError,
  isTransportError,
  upsertWithRetry,
  withRetry,
} from '../../scripts/lib/sync-retry.mjs'

// The weekly oracle sync died on `canceling statement due to statement timeout`
// partway through its upserts, abandoning every remaining row until the next
// Sunday. oracle_cards has three GIN indexes, so a large batch is genuinely
// expensive to write; these guard the two halves of the fix — recognising the
// cancellation as transient, and shrinking the statement that caused it.

const rows = n => Array.from({ length: n }, (_, i) => ({ oracle_id: String(i) }))
const timeout = { code: '57014', message: 'canceling statement due to statement timeout' }

describe('isRetryableError', () => {
  it('recognises a statement timeout by SQLSTATE', () => {
    expect(isRetryableError(timeout)).toBe(true)
    expect(isRetryableError({ code: '57014', message: '' })).toBe(true)
  })

  it('recognises one by message when no code came through', () => {
    expect(isRetryableError({ message: 'canceling statement due to statement timeout' })).toBe(true)
    expect(isRetryableError({ message: 'deadlock detected' })).toBe(true)
  })

  it('recognises dropped connections, which are safe to repeat on an idempotent upsert', () => {
    for (const message of ['fetch failed', 'socket hang up', 'read ECONNRESET', 'getaddrinfo EAI_AGAIN db.host']) {
      expect(isRetryableError({ message })).toBe(true)
    }
  })

  it('does not retry a genuine data error', () => {
    // Repeating a constraint violation just fails again, slower.
    expect(isRetryableError({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false)
    expect(isRetryableError({ code: '42703', message: 'column "nope" does not exist' })).toBe(false)
    expect(isRetryableError(null)).toBe(false)
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

// ── Gateway failures ────────────────────────────────────────────────────────
// The 2026-09-13 outage. Three 504s — the only three the project served that
// day — ended both scheduled syncs, because the classifier above was written
// for statement timeouts and dropped sockets. PostgREST reports a 504 as
// `message: "Gateway Timeout"`, which matched none of those patterns, so even
// the already-retried oracle writes rethrew it.

const gateway = { message: 'Gateway Timeout' }

describe('gateway failures are transient, not fatal', () => {
  it('recognises the exact error that killed both syncs', () => {
    expect(isRetryableError(gateway)).toBe(true)
    expect(isTransportError(gateway)).toBe(true)
  })

  it('recognises one reported as a status code rather than a message', () => {
    for (const status of [502, 503, 504]) {
      expect(isRetryableError({ status, message: 'Request failed' })).toBe(true)
    }
  })

  it('does not treat a gateway failure as an oversized statement', () => {
    // The distinction drives the response: halving a batch is a real fix for a
    // statement timeout and pointless for a gateway that cannot reach the DB.
    expect(isOversizedStatementError(gateway)).toBe(false)
    expect(isTransportError(timeout)).toBe(false)
  })

  it('backs off on a gateway failure instead of splitting the batch', async () => {
    const sizes = []
    let attempts = 0
    await upsertWithRetry(rows(100), batch => {
      sizes.push(batch.length)
      attempts++
      return { error: attempts < 3 ? gateway : null }
    }, { minBatch: 25, wait: async () => {} })

    // Every attempt carried the full batch: no split was attempted.
    expect(sizes).toEqual([100, 100, 100])
  })
})

describe('withRetry', () => {
  const noWait = async () => {}

  it('returns the first successful result without retrying', async () => {
    let calls = 0
    const result = await withRetry(() => { calls++; return { data: [1, 2], error: null } }, { wait: noWait })
    expect(result.data).toEqual([1, 2])
    expect(calls).toBe(1)
  })

  it('retries a read that hit a gateway failure and returns the eventual data', async () => {
    // The oracle sync died here: one 504 on page 1 of 39, five seconds in,
    // having written nothing.
    let calls = 0
    const result = await withRetry(() => {
      calls++
      return calls < 3 ? { data: null, error: gateway } : { data: ['ok'], error: null }
    }, { wait: noWait })

    expect(calls).toBe(3)
    expect(result.data).toEqual(['ok'])
  })

  it('grows the delay between attempts', async () => {
    const delays = []
    let calls = 0
    await withRetry(() => {
      calls++
      return calls < 3 ? { error: gateway } : { error: null }
    }, { wait: async ms => { delays.push(ms) } })

    expect(delays).toEqual([1000, 2000])
  })

  it('gives up after the budget so a dead instance still fails loudly', async () => {
    let calls = 0
    await expect(withRetry(() => { calls++; return { error: gateway } }, { wait: noWait }))
      .rejects.toMatchObject({ message: 'Gateway Timeout' })
    expect(calls).toBe(4)
  })

  it('throws a genuine query error immediately', async () => {
    let calls = 0
    const bad = { code: '42703', message: 'column "nope" does not exist' }
    await expect(withRetry(() => { calls++; return { error: bad } }, { wait: noWait }))
      .rejects.toMatchObject({ code: '42703' })
    expect(calls).toBe(1)
  })
})
