/**
 * visionClient — main-thread handle on the vision worker
 *
 * Presents the scan pipeline as async calls; frames are posted with their
 * pixel buffers in the transfer list (zero copy — the caller's ImageData is
 * neutered afterwards, which is fine because every capture produces a fresh
 * one). When Workers are unavailable or the worker crashes, calls fall back
 * to running ScannerEngine synchronously on the main thread.
 */

import {
  detectCardCorners, warpCard, cropCardFromReticle, cropArtRegion,
  rotateCard180, computeAllHashes, computeFullCardHash, isUsableArtCrop,
} from './ScannerEngine.js'
import { flattenTileHashes } from './tileHash.js'

function serializeHashes(h) {
  return {
    hash: h.hash ? Array.from(h.hash) : null,
    foilHash: h.foilHash ? Array.from(h.foilHash) : null,
    darkHash: h.darkHash ? Array.from(h.darkHash) : null,
    colorHash: h.colorHash ? Array.from(h.colorHash) : null,
    tileHashes: h.tileHashes ? Array.from(flattenTileHashes(h.tileHashes)) : null,
  }
}

class VisionClient {
  _worker = null
  _failed = false
  _seq = 1
  _pending = new Map()
  // Main-thread fallback state (mirrors the worker's currentCard slot)
  _localCard = null
  _localCard180 = null

  _ensureWorker() {
    if (this._failed || typeof Worker === 'undefined') return null
    if (this._worker) return this._worker
    try {
      this._worker = new Worker(new URL('./visionWorker.js', import.meta.url), { type: 'module' })
      this._worker.onmessage = event => {
        const { id, ok, result, error } = event.data || {}
        const pending = this._pending.get(id)
        if (!pending) return
        this._pending.delete(id)
        if (ok) pending.resolve(result)
        else pending.reject(new Error(error || 'Vision worker failed'))
      }
      this._worker.onerror = error => {
        this._failed = true
        for (const pending of this._pending.values()) {
          pending.reject(new Error(error?.message || 'Vision worker failed'))
        }
        this._pending.clear()
        this._worker?.terminate()
        this._worker = null
      }
      return this._worker
    } catch {
      this._failed = true
      return null
    }
  }

  _post(type, payload, transfer = []) {
    const worker = this._ensureWorker()
    if (!worker) return Promise.reject(new Error('Vision worker unavailable'))
    const id = this._seq++
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      try {
        worker.postMessage({ id, type, payload }, transfer)
      } catch (e) {
        // A throwing postMessage (non-cloneable payload) rejects this promise
        // anyway; without the delete the entry would sit in _pending forever.
        this._pending.delete(id)
        throw e
      }
    })
  }

  static _frame(imageData) {
    return { data: imageData.data, width: imageData.width, height: imageData.height }
  }

  /**
   * Whether a frame can still be processed on the main thread.
   *
   * Frames are posted to the worker with their pixel buffer in the transfer
   * list, so by the time a call REJECTS the buffer may already be detached —
   * running the fallback on it would silently process zero bytes. That only
   * happens when the worker died mid-call; a worker that was never available
   * rejects before postMessage and leaves the buffer intact.
   */
  static _usable(imageData) {
    return imageData.data.byteLength > 0
  }

  /** Detect card corners on a (downscaled) frame. quick = pass 1 only. */
  async detect(imageData, { quick = false } = {}) {
    try {
      const { corners } = await this._post(
        'detect',
        { frame: VisionClient._frame(imageData), quick },
        [imageData.data.buffer],
      )
      return corners
    } catch {
      if (!VisionClient._usable(imageData)) return null
      return detectCardCorners(imageData, imageData.width, imageData.height, { maxPasses: quick ? 1 : 4 })
    }
  }

  /** Warp the card quad out of a full frame; keeps it as the current card. */
  async loadWarped(imageData, corners) {
    try {
      const { ok } = await this._post(
        'loadWarped',
        { frame: VisionClient._frame(imageData), corners },
        [imageData.data.buffer],
      )
      return ok
    } catch {
      if (!VisionClient._usable(imageData)) return false
      this._localCard = warpCard(imageData, corners)
      this._localCard180 = null
      return !!this._localCard
    }
  }

  /** Blind-crop the reticle region as the current card. */
  async loadReticle(imageData, viewportWidth, viewportHeight) {
    try {
      const { ok } = await this._post(
        'loadReticle',
        { frame: VisionClient._frame(imageData), viewportWidth, viewportHeight },
        [imageData.data.buffer],
      )
      return ok
    } catch {
      if (!VisionClient._usable(imageData)) return false
      this._localCard = cropCardFromReticle(
        imageData, imageData.width, imageData.height, viewportWidth, viewportHeight,
      )
      this._localCard180 = null
      return !!this._localCard
    }
  }

  /**
   * Compute all hash variants for a batch of crop variants against the
   * current card (optionally rotated 180°), plus the shared whole-card hash
   * for that orientation. `tileGrid` (the loaded pack's grid, 0 = none) adds
   * v8 tile hashes per variant. Returns { results, fullHash }; result entries
   * are null when the crop was unusable. Hash arrays are plain number[] ready
   * for the match worker.
   */
  async hashVariants(variants, { rot180 = false, tileGrid = 0 } = {}) {
    try {
      return await this._post('hashVariants', { variants, rot180, tileGrid })
    } catch {
      let base = this._localCard
      if (rot180 && base) {
        this._localCard180 ??= rotateCard180(base)
        base = this._localCard180
      }
      if (!base) return { results: [], fullHash: null }
      const results = variants.map(variant => {
        const art = cropArtRegion(base, variant)
        if (!art || !isUsableArtCrop(art)) return null
        try { return serializeHashes(computeAllHashes(art, { tileGrid })) } catch { return null }
      })
      let fullHash = null
      try {
        base._fullHash ??= computeFullCardHash(base)
        fullHash = Array.from(base._fullHash)
      } catch { /* no-op */ }
      return { results, fullHash }
    }
  }
}

export const visionClient = new VisionClient()
