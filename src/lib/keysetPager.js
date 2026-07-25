// ── keysetPager.js ────────────────────────────────────────────────────────────
// Cursor ("keyset") pagination for Supabase reads that walk a whole table.
//
// `.range(from, from + 999)` is OFFSET paging: the server still scans and
// discards every skipped row, so page N costs O(N × PAGE). On owned_cards_view
// each scanned row also drags a join into card_prints, which put page 5 of a
// 12k-card collection at ~4.5s and page ~9 past the 8s statement timeout —
// the sync died with a 500 partway through.
//
// Seeking on the last id read instead makes every page cost the same (~14ms
// measured, offset 4000 → keyset, same collection) no matter how deep it is.
//
// The query must be ordered by a unique, ascending, non-null column (`id`);
// `fetchAllByKeyset` applies the ordering itself so a caller can't order by
// something else and silently skip rows.

export const KEYSET_PAGE = 1000

/**
 * @param makeQuery  () => PostgrestFilterBuilder — the base select + filters,
 *                   without order/limit/range (those are applied here).
 * @param options    { page, column } — page size and the cursor column.
 * @returns every matching row, in ascending `column` order.
 */
export async function fetchAllByKeyset(makeQuery, { page = KEYSET_PAGE, column = 'id', shard = null } = {}) {
  const rows = []
  let after = null

  while (true) {
    let query = makeQuery()
    if (shard?.from != null) query = query.gte(column, shard.from)
    if (shard?.to != null) query = query.lt(column, shard.to)
    if (after != null) query = query.gt(column, after)

    const { data, error } = await query.order(column).limit(page)
    if (error) throw error
    if (data?.length) rows.push(...data)
    if (!data || data.length < page) break

    // A null/missing cursor value can't be seeked past — stop with what we have
    // rather than re-requesting the same page forever.
    const next = data[data.length - 1]?.[column]
    if (next == null) break
    after = next
  }

  return rows
}

// Splits the uuid space into `count` half-open [from, to) buckets. Ids are
// uuid v4, so the leading hex nibble is uniform and the buckets come out
// roughly even. The first bucket has no lower bound and the last no upper
// bound, which keeps them exhaustive regardless of what a uuid can look like.
export function uuidShards(count) {
  if (!Number.isInteger(count) || count < 2) return [{ from: null, to: null }]

  const boundary = i => {
    // 8 hex digits of the id is far more precision than the split needs and
    // keeps the bound short; the rest of the uuid compares lexicographically
    // after it, which is exactly how Postgres orders uuids.
    const prefix = Math.floor((i * 0x100000000) / count).toString(16).padStart(8, '0')
    return `${prefix}-0000-0000-0000-000000000000`
  }

  return Array.from({ length: count }, (_, i) => ({
    from: i === 0 ? null : boundary(i),
    to: i === count - 1 ? null : boundary(i + 1),
  }))
}

// Walks the same query as fetchAllByKeyset, but splits the id space into
// independent shards fetched concurrently.
//
// A single keyset walk is inherently sequential — each page needs the previous
// page's last id — so a 14k-row collection cost 14 serial round trips (~10s on
// a cold cache, each page paying a CORS preflight too). Sharding turns that
// into `shards` walks of ~14/shards pages running at once.
//
// Only worth it for a cold full fetch; ordinary incremental syncs move few
// enough rows that one walk is a single request.
export async function fetchAllByKeysetSharded(makeQuery, { page = KEYSET_PAGE, column = 'id', shards = 4 } = {}) {
  const buckets = uuidShards(shards)
  const results = await Promise.all(
    buckets.map(shard => fetchAllByKeyset(makeQuery, { page, column, shard })),
  )
  return results.flat()
}
