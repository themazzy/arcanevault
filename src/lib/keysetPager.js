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
export async function fetchAllByKeyset(makeQuery, { page = KEYSET_PAGE, column = 'id' } = {}) {
  const rows = []
  let after = null

  while (true) {
    let query = makeQuery()
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
