import { describe, it, expect } from 'vitest'
import { fetchAllByKeyset } from './keysetPager'

// Minimal stand-in for a PostgrestFilterBuilder: records the gt/order/limit
// calls and serves rows out of a sorted array.
function makeFakeTable(rows, { onQuery } = {}) {
  return () => {
    const state = { gt: null, column: 'id', limit: null }
    const builder = {
      gt(column, value) { state.gt = { column, value }; return builder },
      order(column) { state.column = column; return builder },
      async limit(n) {
        state.limit = n
        onQuery?.({ ...state })
        const sorted = [...rows].sort((a, b) => (a[state.column] > b[state.column] ? 1 : -1))
        const start = state.gt ? sorted.findIndex(r => r[state.gt.column] > state.gt.value) : 0
        if (start === -1) return { data: [], error: null }
        return { data: sorted.slice(start, start + n), error: null }
      },
    }
    return builder
  }
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
