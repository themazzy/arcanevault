import { describe, it, expect } from 'vitest'
import { fetchAllByKeyset, fetchAllByKeysetSharded, uuidShards } from './keysetPager'

// Minimal stand-in for a PostgrestFilterBuilder: records the gt/gte/lt/order/
// limit calls and serves rows out of a sorted array.
function makeFakeTable(rows, { onQuery } = {}) {
  return () => {
    const state = { gt: null, gte: null, lt: null, column: 'id', limit: null }
    const builder = {
      gt(column, value) { state.gt = { column, value }; return builder },
      gte(column, value) { state.gte = { column, value }; return builder },
      lt(column, value) { state.lt = { column, value }; return builder },
      order(column) { state.column = column; return builder },
      async limit(n) {
        state.limit = n
        onQuery?.({ ...state })
        const col = state.column
        let matched = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : -1))
        if (state.gte) matched = matched.filter(r => r[state.gte.column] >= state.gte.value)
        if (state.lt) matched = matched.filter(r => r[state.lt.column] < state.lt.value)
        const start = state.gt ? matched.findIndex(r => r[state.gt.column] > state.gt.value) : 0
        if (start === -1) return { data: [], error: null }
        return { data: matched.slice(start, start + n), error: null }
      },
    }
    return builder
  }
}

// uuid-v4-shaped ids with a spread of leading nibbles, so the shard boundaries
// actually split them.
function uuidRows(n) {
  return Array.from({ length: n }, (_, i) => {
    const hex = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0')
    return { id: `${hex}-0000-4000-8000-${String(i).padStart(12, '0')}` }
  })
}

const rowsOf = n => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(4, '0')}` }))

describe('fetchAllByKeyset', () => {
  it('returns every row across multiple pages', async () => {
    const rows = rowsOf(2500)
    const out = await fetchAllByKeyset(makeFakeTable(rows), { page: 1000 })
    expect(out.map(r => r.id)).toEqual(rows.map(r => r.id))
  })

  it('seeks past the last id instead of offsetting', async () => {
    const queries = []
    await fetchAllByKeyset(makeFakeTable(rowsOf(2500), { onQuery: q => queries.push(q) }), { page: 1000 })

    expect(queries).toHaveLength(3)
    expect(queries[0].gt).toBeNull()
    expect(queries[1].gt).toEqual({ column: 'id', value: 'id-0999' })
    expect(queries[2].gt).toEqual({ column: 'id', value: 'id-1999' })
    expect(queries.every(q => q.limit === 1000)).toBe(true)
  })

  it('stops after a short page', async () => {
    const queries = []
    const out = await fetchAllByKeyset(makeFakeTable(rowsOf(400), { onQuery: q => queries.push(q) }), { page: 1000 })
    expect(out).toHaveLength(400)
    expect(queries).toHaveLength(1)
  })

  it('stops on an exactly-full final page', async () => {
    const out = await fetchAllByKeyset(makeFakeTable(rowsOf(2000)), { page: 1000 })
    expect(out).toHaveLength(2000)
  })

  it('handles an empty table', async () => {
    expect(await fetchAllByKeyset(makeFakeTable([]), { page: 1000 })).toEqual([])
  })

  it('supports a non-id cursor column', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ seq: i }))
    const out = await fetchAllByKeyset(makeFakeTable(rows), { page: 1000, column: 'seq' })
    expect(out).toHaveLength(1500)
    expect(out.map(r => r.seq)).toEqual(rows.map(r => r.seq))
  })

  it('propagates query errors', async () => {
    const failing = () => ({
      gt() { return this },
      order() { return this },
      async limit() { return { data: null, error: new Error('statement timeout') } },
    })
    await expect(fetchAllByKeyset(failing)).rejects.toThrow('statement timeout')
  })

  it('restricts a walk to its shard range', async () => {
    const rows = uuidRows(50)
    const shard = { from: '40000000-0000-0000-0000-000000000000', to: '80000000-0000-0000-0000-000000000000' }

    const out = await fetchAllByKeyset(makeFakeTable(rows), { page: 1000, shard })

    expect(out.length).toBeGreaterThan(0)
    expect(out.every(r => r.id >= shard.from && r.id < shard.to)).toBe(true)
  })
})

describe('uuidShards', () => {
  it('covers the whole id space with disjoint, ordered buckets', () => {
    const shards = uuidShards(4)
    expect(shards).toHaveLength(4)
    // Open at both ends so no id can fall outside the set.
    expect(shards[0].from).toBeNull()
    expect(shards[3].to).toBeNull()
    // Each bucket starts exactly where the previous one ended — no gap, no overlap.
    for (let i = 1; i < shards.length; i++) {
      expect(shards[i].from).toBe(shards[i - 1].to)
    }
  })

  it('degrades to a single unbounded bucket for counts below 2', () => {
    expect(uuidShards(1)).toEqual([{ from: null, to: null }])
    expect(uuidShards(0)).toEqual([{ from: null, to: null }])
  })
})

describe('fetchAllByKeysetSharded', () => {
  it('returns every row exactly once across shards', async () => {
    const rows = uuidRows(2500)

    const out = await fetchAllByKeysetSharded(makeFakeTable(rows), { page: 1000, shards: 4 })

    expect(out).toHaveLength(rows.length)
    expect(new Set(out.map(r => r.id)).size).toBe(rows.length)
    expect(out.map(r => r.id).sort()).toEqual(rows.map(r => r.id).sort())
  })

  it('matches an unsharded walk on the same data', async () => {
    const rows = uuidRows(1200)

    const serial = await fetchAllByKeyset(makeFakeTable(rows), { page: 500 })
    const sharded = await fetchAllByKeysetSharded(makeFakeTable(rows), { page: 500, shards: 3 })

    expect(sharded.map(r => r.id).sort()).toEqual(serial.map(r => r.id).sort())
  })

  it('pages within each shard rather than truncating at one page', async () => {
    const rows = uuidRows(900)

    const out = await fetchAllByKeysetSharded(makeFakeTable(rows), { page: 100, shards: 2 })

    expect(out).toHaveLength(900)
  })

  it('handles an empty table', async () => {
    expect(await fetchAllByKeysetSharded(makeFakeTable([]), { shards: 4 })).toEqual([])
  })
})

describe('fetchAllByKeyset edge cases', () => {
  it('bails out instead of looping when the cursor value is null', async () => {
    let calls = 0
    const nullCursor = () => ({
      gt() { return this },
      order() { return this },
      async limit(n) {
        calls++
        return { data: Array.from({ length: n }, () => ({ id: null })), error: null }
      },
    })
    const out = await fetchAllByKeyset(nullCursor, { page: 10 })
    expect(calls).toBe(1)
    expect(out).toHaveLength(10)
  })
})
