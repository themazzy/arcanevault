import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// waitForOpenCV now downloads the vendored opencv.js from our own origin with a
// streaming fetch (for real byte progress), verifies SRI in JS, then injects it
// as a blob <script> and waits for the WASM runtime (cv.Mat) to appear. These
// tests stub fetch / crypto / DOM so the loader runs in the node test env.
//
// The loader memoises the in-flight load at module scope, so each test imports a
// fresh module instance via resetModules to stay isolated.

// The exact base64 payload from OPENCV_INTEGRITY in ScannerEngine.js — a
// matching digest must reproduce this for the integrity check to pass.
const INTEGRITY_PAYLOAD = 'kEC+2KaGZ4b+M4g8HgCNH9N+2TfOMWcNR6Ttw3mclO4ppnH1tX4Xgl9jwfowxoxM'

let injectedScript

function installFakeEnv() {
  injectedScript = null
  global.document = {
    getElementById: () => (injectedScript?.id === 'opencv-script' ? injectedScript : null),
    createElement: () => ({ _onerror: null, set onerror(f) { this._onerror = f }, get onerror() { return this._onerror } }),
    head: { appendChild: (el) => { injectedScript = el } },
  }
  global.window = {}
  // Node already provides URL/Blob constructors — only stub the object-URL
  // statics the loader uses (replacing the whole global breaks vitest internals).
  global.URL.createObjectURL = () => 'blob:opencv'
  global.URL.revokeObjectURL = () => {}
}

// Build a fake streaming Response that yields the given chunks (Uint8Arrays).
function streamingResponse(chunks, { ok = true, status = 200, contentLength } = {}) {
  let i = 0
  return {
    ok,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
    arrayBuffer: async () => { throw new Error('should not be called when streaming') },
  }
}

function digestFromBase64(payload) {
  return Uint8Array.from(Buffer.from(payload, 'base64')).buffer
}
function setDigest(buffer) {
  global.crypto = { subtle: { digest: vi.fn().mockResolvedValue(buffer) } }
}

async function loadEngine() {
  vi.resetModules()
  return import('./ScannerEngine')
}

beforeEach(() => {
  vi.useFakeTimers()
  installFakeEnv()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete global.URL.createObjectURL
  delete global.URL.revokeObjectURL
  for (const k of ['document', 'window', 'fetch', 'crypto']) delete global[k]
})

describe('waitForOpenCV', () => {
  it('resolves immediately when OpenCV is already ready (no download)', async () => {
    const { waitForOpenCV } = await loadEngine()
    global.window.cv = { Mat: function () {} }
    global.fetch = vi.fn()
    await expect(waitForOpenCV()).resolves.toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('downloads from our own origin, not docs.opencv.org', async () => {
    const { waitForOpenCV } = await loadEngine()
    global.fetch = vi.fn().mockResolvedValue(streamingResponse([new Uint8Array([1])], { contentLength: 1 }))
    setDigest(digestFromBase64(INTEGRITY_PAYLOAD))
    const p = waitForOpenCV()
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(10)
    const url = global.fetch.mock.calls[0][0]
    expect(url).not.toMatch(/docs\.opencv\.org/)
    expect(url).toMatch(/opencv\/opencv\.js$/)
    // resolve the load so it doesn't leak
    global.window.cv = { Mat: function () {} }
    await vi.advanceTimersByTimeAsync(120)
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects on an HTTP error', async () => {
    const { waitForOpenCV } = await loadEngine()
    global.fetch = vi.fn().mockResolvedValue(streamingResponse([], { ok: false, status: 404 }))
    const p = waitForOpenCV()
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(10)
    await expect(p).rejects.toThrow(/HTTP 404/)
  })

  it('rejects when the integrity check fails (tampered/corrupted bytes)', async () => {
    const { waitForOpenCV } = await loadEngine()
    global.fetch = vi.fn().mockResolvedValue(streamingResponse([new Uint8Array([9, 9, 9])], { contentLength: 3 }))
    setDigest(new Uint8Array(48).buffer) // all-zero digest ≠ pinned hash
    const p = waitForOpenCV()
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(10)
    await expect(p).rejects.toThrow(/integrity check failed/i)
    expect(injectedScript).toBeNull() // never injected bad bytes
  })

  it('reports byte progress, verifies integrity, injects a blob script, and resolves when cv.Mat appears', async () => {
    const { waitForOpenCV } = await loadEngine()
    global.fetch = vi.fn().mockResolvedValue(
      streamingResponse([new Uint8Array(4), new Uint8Array(6)], { contentLength: 10 }),
    )
    setDigest(digestFromBase64(INTEGRITY_PAYLOAD))
    const ratios = []
    const p = waitForOpenCV({ onProgress: ({ ratio }) => ratios.push(ratio) })

    await vi.advanceTimersByTimeAsync(10) // download + verify + inject
    expect(injectedScript).not.toBeNull()
    expect(injectedScript.src).toBe('blob:opencv')
    expect(ratios).toEqual([0.4, 1])

    global.window.cv = { Mat: function () {} } // simulate WASM init completing
    await vi.advanceTimersByTimeAsync(120)
    await expect(p).resolves.toBeUndefined()
  })

  it('emits a null ratio when the server omits Content-Length', async () => {
    const { waitForOpenCV } = await loadEngine()
    global.fetch = vi.fn().mockResolvedValue(streamingResponse([new Uint8Array(3)])) // no contentLength
    setDigest(digestFromBase64(INTEGRITY_PAYLOAD))
    const ratios = []
    const p = waitForOpenCV({ onProgress: ({ ratio }) => ratios.push(ratio) })
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(ratios).toEqual([null])
    global.window.cv = { Mat: function () {} }
    await vi.advanceTimersByTimeAsync(120)
    await expect(p).resolves.toBeUndefined()
  })
})
