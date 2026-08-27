// Zero-filling daily time series.
//
// None of the three sources returns a row for a day with no activity —
// Cloudflare omits empty groups and deck_view_daily only has rows for days a
// deck was opened. Charting those rows directly is actively misleading: the
// axis is categorical, so a missing day is not drawn as a gap, it is dropped
// and the surviving points close ranks. Three scattered points across a month
// render as an evenly spaced line that looks like a trend.
//
// Filling the range server-side means the chart's x-axis matches real elapsed
// time and a quiet day reads as zero rather than vanishing.
//
// Pure and dependency-free so it can be unit-tested without the Deno runtime.

// Dates are handled as UTC YYYY-MM-DD strings throughout. Constructing local
// Dates and incrementing by a day would drift across a DST boundary.
export function enumerateDates(since: string, until: string, maxDays = 400): string[] {
  const out: string[] = []
  const start = Date.parse(`${since}T00:00:00Z`)
  const end = Date.parse(`${until}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out

  for (let t = start, i = 0; t <= end && i < maxDays; t += 86400000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/**
 * Returns one row per day from `since` to `until` inclusive, in date order.
 * Days present in `rows` keep their row; days that are absent get `zero`.
 *
 * Rows outside the range are dropped, and a duplicate date keeps the first
 * occurrence, so a malformed upstream response cannot lengthen the series.
 */
export function fillDailySeries<T extends Record<string, unknown>>(
  rows: Array<T & { date?: string | null }> | null | undefined,
  { since, until, zero }: { since: string; until: string; zero: T },
): Array<T & { date: string }> {
  const byDate = new Map<string, T>()
  for (const row of rows || []) {
    const date = row?.date
    if (typeof date === 'string' && date && !byDate.has(date)) byDate.set(date, row)
  }

  return enumerateDates(since, until).map(date => {
    const row = byDate.get(date)
    return { ...(row ?? zero), date } as T & { date: string }
  })
}
