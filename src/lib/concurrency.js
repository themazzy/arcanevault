// Bounded-parallelism and retry helpers.
//
// A leaf module on purpose: it imports nothing. runWithConcurrency used to live
// in sharedCardPrices.js, which cannot be imported from cardPrints.js — that
// would close the cycle cardPrints -> sharedCardPrices -> scryfall ->
// cardPrints. Both callers now depend on this instead of on each other.

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the results.
 *
 * Failure semantics are deliberately all-or-nothing: the first rejection
 * propagates and the remaining items are abandoned. Callers here treat a
 * partial result as worse than none — a half-populated metadata map would be
 * cached and then read as complete. Use `withRetry` to absorb the transient
 * failures that should not abort a run.
 */
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Retry `fn` with bounded exponential backoff and jitter.
 *
 * Why this exists: enrichFromCardPrints catches any failure by handing every
 * card to Scryfall, which is rate-limited at 75/batch + 120 ms — roughly 18
 * seconds of pure throttling for a large collection. Before retries, a single
 * transient failure on any one of ~57 batches was enough to trigger that, and
 * raising the parallelism raises the number of requests exposed to a bad
 * moment. Retrying the batch is far cheaper than the fallback it prevents.
 *
 * Jitter matters at concurrency > 1: without it, batches that fail together
 * (a brief upstream blip) would retry in lockstep and recreate the same spike.
 *
 * @param {() => Promise<T>} fn
 * @param {object}   [opts]
 * @param {number}   [opts.attempts=3]     total tries, not extra tries
 * @param {number}   [opts.baseDelayMs=200] first backoff; doubles each retry
 * @param {(err: unknown) => boolean} [opts.shouldRetry] defaults to retrying everything
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { attempts = 3, baseDelayMs = 200, shouldRetry = () => true } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const isLast = attempt === attempts - 1
      if (isLast || !shouldRetry(err)) throw err
      // Full jitter over the window rather than a fixed delay: retrying a
      // batch is cheap, retrying every batch at the same instant is not.
      const window = baseDelayMs * 2 ** attempt
      await sleep(Math.random() * window)
    }
  }
  throw lastError
}
