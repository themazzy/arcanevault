// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const order = vi.fn()
const eq = vi.fn(() => ({ order }))
const select = vi.fn(() => ({ eq }))
vi.mock('../lib/supabase', () => ({ sb: { from: vi.fn(() => ({ select })) } }))

const getLocalFolders = vi.fn()
const putFolders = vi.fn(() => Promise.resolve())
vi.mock('../lib/db', () => ({
  getLocalFolders: (...args) => getLocalFolders(...args),
  putFolders: (...args) => putFolders(...args),
}))

const { useAllFolders } = await import('./useAllFolders')

function Probe({ userId }) {
  const [folders] = useAllFolders(userId)
  return <ul>{folders.map(f => <li key={f.id}>{f.name}</li>)}</ul>
}

const REMOTE = [
  { id: 'r1', user_id: 'u1', name: 'Remote Binder', type: 'binder' },
  { id: 'r2', user_id: 'u1', name: 'Remote Deck', type: 'deck' },
]

beforeEach(() => {
  getLocalFolders.mockReset().mockResolvedValue([])
  putFolders.mockClear()
  select.mockClear()
  eq.mockClear()
  order.mockReset().mockResolvedValue({ data: REMOTE, error: null })
})
afterEach(cleanup)

describe('useAllFolders', () => {
  it('falls back to Supabase when the IDB cache is empty', async () => {
    // The bug this fixes: the Move dialog read IDB only, so an account with
    // plenty of binders showed "No binders yet" whenever the local cache had
    // not been populated in that session.
    render(<Probe userId="u1" />)
    await waitFor(() => expect(screen.getByText('Remote Binder')).toBeTruthy())
    expect(screen.getByText('Remote Deck')).toBeTruthy()
  })

  it('writes the fetched folders back to IDB so other readers heal', async () => {
    render(<Probe userId="u1" />)
    await waitFor(() => expect(putFolders).toHaveBeenCalledWith(REMOTE))
  })

  it('selects user_id, without which the cached rows are unreachable by index', async () => {
    render(<Probe userId="u1" />)
    await waitFor(() => expect(select).toHaveBeenCalled())
    expect(select.mock.calls[0][0]).toContain('user_id')
  })

  it('paints the IDB rows first, then replaces them with the server list', async () => {
    getLocalFolders.mockResolvedValue([{ id: 'c1', user_id: 'u1', name: 'Cached Binder', type: 'binder' }])
    render(<Probe userId="u1" />)
    await waitFor(() => expect(screen.getByText('Remote Binder')).toBeTruthy())
    expect(screen.queryByText('Cached Binder')).toBeNull()
  })

  it('does not let a slow IDB read clobber the server list', async () => {
    let resolveLocal
    getLocalFolders.mockReturnValue(new Promise(res => { resolveLocal = res }))
    render(<Probe userId="u1" />)
    await waitFor(() => expect(screen.getByText('Remote Binder')).toBeTruthy())

    await act(async () => {
      resolveLocal([{ id: 'stale', user_id: 'u1', name: 'Stale Binder', type: 'binder' }])
    })
    expect(screen.queryByText('Stale Binder')).toBeNull()
    expect(screen.getByText('Remote Binder')).toBeTruthy()
  })

  it('keeps the cached rows when the fetch errors', async () => {
    getLocalFolders.mockResolvedValue([{ id: 'c1', user_id: 'u1', name: 'Cached Binder', type: 'binder' }])
    order.mockResolvedValue({ data: null, error: { message: 'offline' } })
    render(<Probe userId="u1" />)
    await waitFor(() => expect(screen.getByText('Cached Binder')).toBeTruthy())
  })

  it('does not query without a user', async () => {
    render(<Probe userId={null} />)
    expect(getLocalFolders).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })
})
