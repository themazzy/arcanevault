/**
 * Retry helpers shared by the scheduled Supabase syncs.
 *
 * Both nightly jobs died on 2026-09-13 to a total of three 504s — the only
 * three the project served in 24 hours:
 *
 *   08:25  GET  /card_prints  (backfill walk)      → price sync
 *   08:28  POST /card_prices  (batch 201 of ~203)  → price sync
 *   12:42  GET  /oracle_cards (its FIRST read)     → oracle sync
 *
 * Two separate gaps let a one-off blip end a whole run.
 *
 * 1. Only writes were ever protected. The keyset READ walks were plain
 *    `if (error) throw error`, so the oracle sync was dead five seconds in, on
 *    page 1 of 39, having written nothing.
 *
 * 2. The existing classifier did not recognise a gateway failure. It was built
 *    for statement timeouts (57014) and dropped sockets; PostgREST surfaces a
 *    504 as `message: "Gateway Timeout"`, which matched none of those patterns
 *    — so even the protected writes rethrew it.
 *
 * The two failure classes want opposite responses, which is why they are
 * classified separately below rather than folded into one "retryable" flag:
 *
 *   - An OVERSIZED statement (57014, deadlock) is fixed by asking for less, so
 *     the batch is halved. Repeating the same oversized statement only waits.
 *   - A TRANSPORT failure (504/502/503, dropped socket) has nothing to do with
 *     how much was asked for. The oracle 504 came back in ~25 ms, far too fast
 *     to be work — the gateway simply could not reach the database. Splitting
 *     it just issues two doomed requests instead of one; the fix is to wait.
 */

export const DEFAULT_ATTEMPTS = 4
export const DEFAULT_BASE_DELAY_MS = 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The statement asked for more than it was allowed to do. Halving it helps.
 */
export function isOversizedStatementError(error) {
  if (!error) return false
  if (error.code === '57014') return true
  return /canceling statement|statement timeout|deadlock detected/i.test(String(error?.message || ''))
}

/**
 * The request never got a useful answer from the database. Waiting helps;
 * making it smaller does not.
 *
 * PostgREST/Supabase hand these back as the HTTP status text rather than a
 * SQLSTATE, so the message is all there is to match on.
 */
export function isTransportError(error) {
  if (!error) return false
  const status = Number(error.status ?? error.statusCode ?? NaN)
  if (status === 502 || status === 503 || status === 504) return true
  return /gateway timeout|bad gateway|service unavailable|server closed the connection|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i
    .test(String(error?.message || ''))
}

/**
 * Worth trying again at all. A constraint violation or a missing column is not
 * — repeating it just fails again, slower.
 */
export function isRetryableError(error) {
  return isOversizedStatementError(error) || isTransportError(error)
}

/**
 * Run one Supabase operation, retrying transient failures with exponential
 * backoff. For reads, where there is no batch to shrink.
 *
 * `run` returns Supabase's `{ data, error }`; the resolved value is passed
 * straight back so callers keep their normal shape.
 */
export async function withRetry(run, opts = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    wait = sleep,
    onRetry,
  } = opts

  for (let attempt = 1; ; attempt++) {
    const result = await run()
    const error = result?.error
    if (!error) return result
    if (!isRetryableError(error) || attempt >= attempts) throw error

    const delay = baseDelayMs * 2 ** (attempt - 1)
    onRetry?.({ attempt, attempts, delay, error })
    await wait(delay)
  }
}

/**
 * Write one batch, retrying transient failures.
 *
 * An oversized statement is halved — that is an actual fix for the cause. A
 * transport failure is not: it backs off and repeats the batch whole, because
 * the size was never the problem. Both give up after the attempt budget so a
 * genuinely dead instance still fails the job loudly rather than silently
 * writing nothing.
 *
 * `upsert` is injected so this can be tested without a database.
 *
 * @param {object[]} rows
 * @param {(rows: object[]) => Promise<{error: any}>} upsert
 */
export async function upsertWithRetry(rows, upsert, opts = {}) {
  const {
    minBatch = 25,
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    wait = sleep,
    onRetry,
  } = opts
  if (!rows.length) return

  for (let attempt = 1; ; attempt++) {
    const { error } = await upsert(rows)
    if (!error) return
    if (!isRetryableError(error)) throw error

    if (isOversizedStatementError(error) && rows.length > minBatch) {
      const half = Math.ceil(rows.length / 2)
      onRetry?.({ reason: 'split', size: rows.length, next: half, error })
      await upsertWithRetry(rows.slice(0, half), upsert, opts)
      await upsertWithRetry(rows.slice(half), upsert, opts)
      return
    }
    if (attempt >= attempts) throw error

    const delay = baseDelayMs * 2 ** (attempt - 1)
    onRetry?.({ reason: 'backoff', size: rows.length, attempt, delay, error })
    await wait(delay)
  }
}
