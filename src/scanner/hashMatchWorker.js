/**
 * hashMatchWorker — owns the hash-pack data and runs all matching off the
 * main thread. Chunks arrive as raw ArrayBuffers (a structured-clone of an
 * ArrayBuffer is a plain memcpy — no 106k-object graph traversal like the
 * old per-card protocol).
 */

import { HashPackStore } from './hashPack'
import { createMatcher } from './matchCore'

let store = new HashPackStore()
let matcher = createMatcher(store)

const toSet = (arr) => (arr?.length ? new Set(arr.map(code => String(code).toLowerCase())) : null)

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === 'reset') {
      store = new HashPackStore()
      matcher = createMatcher(store)
      self.postMessage({ id, ok: true, result: { count: 0 } })
      return
    }

    if (type === 'appendChunk') {
      store.appendChunkBuffer(payload.buffer)
      matcher.invalidate()
      self.postMessage({ id, ok: true, result: { count: store.count } })
      return
    }

    if (type === 'match') {
      const hash = new Uint32Array(payload.hash)
      const colorHash = payload.colorHash ? new Uint32Array(payload.colorHash) : null
      const fullHash = payload.fullHash ? new Uint32Array(payload.fullHash) : null
      const opts = { ...(payload.opts || {}), allowedSets: toSet(payload.opts?.allowedSets) }
      self.postMessage({ id, ok: true, result: matcher.match(hash, colorHash, fullHash, opts) })
      return
    }

    if (type === 'matchAll') {
      const colorHash = payload.colorHash ? new Uint32Array(payload.colorHash) : null
      const fullHash = payload.fullHash ? new Uint32Array(payload.fullHash) : null
      const opts = { ...(payload.opts || {}), allowedSets: toSet(payload.opts?.allowedSets) }
      const queries = (payload.queries || []).map(({ hash, label }) => ({
        hash: hash ? new Uint32Array(hash) : null,
        label,
      }))
      self.postMessage({ id, ok: true, result: matcher.matchAll(queries, colorHash, fullHash, opts) })
      return
    }

    throw new Error(`Unknown worker message: ${type}`)
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) })
  }
}
