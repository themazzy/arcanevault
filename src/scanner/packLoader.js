/**
 * packLoader.js — fetch + cache orchestration for scanner hash-pack chunks
 *
 * Sources, in order:
 *   1. IndexedDB blob cache (scanner_pack store) — warm start, offline
 *   2. Same-origin static fetch of public/scanner/hashpack/* — on web this is
 *      GitHub Pages (edge-cached via Cloudflare); on native Capacitor serves
 *      the same files from the APK bundle, so first run works fully offline
 *   3. Native only: https://deckloom.app/... — picks up chunks published after
 *      the APK was built
 *
 * The manifest is the small mutable pointer (always revalidated); chunk files
 * are content-named and immutable.
 */

import { Capacitor } from '@capacitor/core'
import { getProdAppUrl } from '../lib/publicUrl'
import {
  getMeta,
  setMeta,
  getPackChunk,
  putPackChunk,
  getPackChunkKeys,
  deletePackChunks,
} from '../lib/db'

// Hash pipeline versions this client can consume. v6 = art+color hashes
// (format v1); v7 adds whole-card hashes, back faces, and flavor names
// (format v2); v8 adds per-tile art hashes (format v3) — features degrade
// gracefully on an older pack, so the client works before AND after a
// reseed is published.
export const SUPPORTED_HASH_VERSIONS = [6, 7, 8]
export const MANIFEST_META_KEY = 'scanner_pack_manifest'
const PACK_PATH = 'scanner/hashpack/'
const CHUNK_FETCH_TIMEOUT_MS = 120000

const localUrl = file => `${import.meta.env.BASE_URL}${PACK_PATH}${file}`
const remoteUrl = file => getProdAppUrl(`/${PACK_PATH}${file}`)

export function isValidManifest(m) {
  return !!m &&
    (m.formatVersion === 1 || m.formatVersion === 2 || m.formatVersion === 3) &&
    SUPPORTED_HASH_VERSIONS.includes(m.hashVersion) &&
    Array.isArray(m.chunks) &&
    m.chunks.length > 0 &&
    m.chunks.every(c => c && typeof c.file === 'string' && c.count > 0 && c.bytes > 0)
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { cache: 'no-cache', signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the freshest valid manifest. Falls back to the IDB-cached copy when
 * no source is reachable (offline web with a previously completed download).
 * Returns { manifest, source } or null.
 */
export async function loadManifest({ timeoutMs = 8000 } = {}) {
  const candidates = [
    fetchJson(localUrl('manifest.json'), timeoutMs).then(m => ({ m, source: 'local' })),
  ]
  if (Capacitor.isNativePlatform()) {
    // The bundled manifest is only as fresh as the APK; also check prod.
    candidates.push(fetchJson(remoteUrl('manifest.json'), timeoutMs).then(m => ({ m, source: 'remote' })))
  }

  const results = (await Promise.all(candidates)).filter(r => isValidManifest(r.m))
  let picked = null
  for (const r of results) {
    if (!picked || String(r.m.generatedAt || '') > String(picked.m.generatedAt || '')) picked = r
  }
  if (picked) {
    await setMeta(MANIFEST_META_KEY, picked.m).catch(() => {})
    return { manifest: picked.m, source: picked.source }
  }

  const cached = await getMeta(MANIFEST_META_KEY).catch(() => null)
  if (isValidManifest(cached)) return { manifest: cached, source: 'cache' }
  return null
}

async function fetchBuffer(url, expectedBytes, onBytes) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CHUNK_FETCH_TIMEOUT_MS)
  try {
    // Chunk names are content-hashed and immutable — any cached copy is valid.
    const res = await fetch(url, { cache: 'force-cache', signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)

    if (res.body?.getReader) {
      const total = Number(res.headers.get('Content-Length')) || expectedBytes || 0
      const reader = res.body.getReader()
      const parts = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        received += value.length
        onBytes?.(received, total)
      }
      const buf = new ArrayBuffer(received)
      const u8 = new Uint8Array(buf)
      let offset = 0
      for (const p of parts) { u8.set(p, offset); offset += p.length }
      return buf
    }
    const buf = await res.arrayBuffer()
    onBytes?.(buf.byteLength, buf.byteLength)
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Load one chunk: IDB → same-origin fetch → (native) prod fetch.
 * Fetched chunks are written back to IDB. `hashVersion` is the manifest's —
 * a cached chunk from a different pack generation is refetched.
 * Returns { buf, fromCache }.
 */
export async function loadChunkBuffer(chunkMeta, { onBytes, hashVersion } = {}) {
  const cached = await getPackChunk(chunkMeta.file).catch(() => null)
  if (cached && cached.hashVersion === hashVersion) {
    // No onBytes for cache hits — byte progress is a download-only signal.
    return { buf: cached.buf, fromCache: true }
  }

  const urls = [localUrl(chunkMeta.file)]
  if (Capacitor.isNativePlatform()) urls.push(remoteUrl(chunkMeta.file))

  let lastError = null
  for (const url of urls) {
    try {
      const buf = await fetchBuffer(url, chunkMeta.bytes, onBytes)
      await putPackChunk({
        file: chunkMeta.file,
        buf,
        bytes: buf.byteLength,
        hashVersion,
        storedAt: Date.now(),
      }).catch(() => {})
      return { buf, fromCache: false }
    } catch (e) {
      lastError = e
    }
  }
  throw lastError ?? new Error(`Failed to load hash pack chunk ${chunkMeta.file}`)
}

/** Drop IDB chunks that the current manifest no longer references. */
export async function prunePackChunks(manifest) {
  try {
    const valid = new Set(manifest.chunks.map(c => c.file))
    const keys = await getPackChunkKeys()
    const stale = keys.filter(k => !valid.has(k))
    await deletePackChunks(stale)
  } catch { /* best-effort */ }
}
