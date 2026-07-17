import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  getMeta: vi.fn(),
  setMeta: vi.fn().mockResolvedValue(undefined),
  getPackChunk: vi.fn(),
  putPackChunk: vi.fn().mockResolvedValue(undefined),
  getPackChunkKeys: vi.fn(),
  deletePackChunks: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/db', () => db)

const { loadManifest, loadChunkBuffer, isValidManifest } = await import('./packLoader')

const validManifest = {
  formatVersion: 2,
  hashVersion: 7,
  generatedAt: '2026-07-03T00:00:00Z',
  chunks: [{ file: 'pack-v7-000-abc.bin', count: 100, bytes: 2048 }],
}

const jsonResponse = body => ({ ok: true, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  db.getMeta.mockResolvedValue(null)
  db.getPackChunk.mockResolvedValue(null)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('loadManifest', () => {
  it('fetches the manifest exactly once', async () => {
    // Native and web are the same origin (server.url -> deckloom.app), so a
    // second "prod fallback" request would just duplicate the first.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(validManifest))
    vi.stubGlobal('fetch', fetchMock)

    await loadManifest()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/scanner/hashpack/manifest.json')
  })

  it('returns the fetched manifest and caches it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(validManifest)))

    const result = await loadManifest()

    expect(result).toEqual({ manifest: validManifest, source: 'network' })
    expect(db.setMeta).toHaveBeenCalledWith('scanner_pack_manifest', validManifest)
  })

  it('falls back to the IDB copy when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    db.getMeta.mockResolvedValue(validManifest)

    const result = await loadManifest()

    expect(result).toEqual({ manifest: validManifest, source: 'cache' })
    expect(db.setMeta).not.toHaveBeenCalled()
  })

  it('falls back to the IDB copy when the served manifest is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ formatVersion: 99 })))
    db.getMeta.mockResolvedValue(validManifest)

    const result = await loadManifest()

    expect(result.source).toBe('cache')
    expect(db.setMeta).not.toHaveBeenCalled()
  })

  it('returns null when neither the network nor IDB has a valid manifest', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    expect(await loadManifest()).toBeNull()
  })
})

describe('loadChunkBuffer', () => {
  const chunk = validManifest.chunks[0]

  it('serves a cached chunk of the same hash version without fetching', async () => {
    const buf = new ArrayBuffer(8)
    db.getPackChunk.mockResolvedValue({ buf, hashVersion: 7 })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await loadChunkBuffer(chunk, { hashVersion: 7 })

    expect(result).toEqual({ buf, fromCache: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refetches when the cached chunk is from another pack generation', async () => {
    db.getPackChunk.mockResolvedValue({ buf: new ArrayBuffer(8), hashVersion: 6 })
    const fresh = new ArrayBuffer(16)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => fresh }))

    const result = await loadChunkBuffer(chunk, { hashVersion: 7 })

    expect(result).toEqual({ buf: fresh, fromCache: false })
  })

  it('fetches the chunk once from the pack URL and writes it back to IDB', async () => {
    const fresh = new ArrayBuffer(16)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => fresh })
    vi.stubGlobal('fetch', fetchMock)

    await loadChunkBuffer(chunk, { hashVersion: 7 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`/scanner/hashpack/${chunk.file}`)
    expect(db.putPackChunk).toHaveBeenCalledWith(
      expect.objectContaining({ file: chunk.file, buf: fresh, hashVersion: 7 }),
    )
  })

  it('propagates the failure when the chunk cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))

    await expect(loadChunkBuffer(chunk, { hashVersion: 7 })).rejects.toThrow('404')
  })
})

describe('isValidManifest', () => {
  it('accepts format versions 1 through 3', () => {
    for (const formatVersion of [1, 2, 3]) {
      expect(isValidManifest({ ...validManifest, formatVersion })).toBe(true)
    }
  })

  it('rejects unsupported hash versions', () => {
    expect(isValidManifest({ ...validManifest, hashVersion: 5 })).toBe(false)
  })

  it('rejects a manifest with no chunks', () => {
    expect(isValidManifest({ ...validManifest, chunks: [] })).toBe(false)
  })
})
