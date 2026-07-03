/**
 * visionWorker — runs the entire vision pipeline (corner detection,
 * perspective warp, art crops, hashing) off the main thread.
 *
 * Frames arrive as { data, width, height } with the pixel buffer transferred
 * (zero copy). The worker holds the most recent warped/reticle card so hash
 * batches for different crop variants and the 180° fallback don't resend the
 * frame. Pure typed-array processing — no OffscreenCanvas dependency.
 */

import {
  detectCardCorners, warpCard, cropCardFromReticle, cropArtRegion,
  rotateCard180, computeAllHashes, computeFullCardHash, isUsableArtCrop,
  extractCollectorStrip, extractCollectorStripFromCard,
  extractTitleStrip, extractTitleStripFromCard,
} from './ScannerEngine.js'

// Current card being scanned (set by loadWarped / loadReticle), plus the
// high-res collector-line and title-bar strips captured from the same frame —
// the frame buffer is gone after load, so strips must be extracted eagerly.
let currentCard = null
let currentCard180 = null
let currentStrip = null
let currentTitleStrip = null

// Transferred frames arrive as Uint8ClampedArray views already — use them
// directly (zero copy); only wrap raw ArrayBuffers.
const toFrame = f => ({
  data: ArrayBuffer.isView(f.data) ? f.data : new Uint8ClampedArray(f.data),
  width: f.width,
  height: f.height,
})

function serializeHashes(h) {
  return {
    hash: h.hash ? Array.from(h.hash) : null,
    foilHash: h.foilHash ? Array.from(h.foilHash) : null,
    darkHash: h.darkHash ? Array.from(h.darkHash) : null,
    colorHash: h.colorHash ? Array.from(h.colorHash) : null,
  }
}

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === 'detect') {
      const frame = toFrame(payload.frame)
      const corners = detectCardCorners(frame, frame.width, frame.height, {
        maxPasses: payload.quick ? 1 : 3,
      })
      self.postMessage({ id, ok: true, result: { corners } })
      return
    }

    if (type === 'loadWarped') {
      const frame = toFrame(payload.frame)
      currentCard = warpCard(frame, payload.corners)
      currentCard180 = null
      currentStrip = currentCard ? extractCollectorStrip(frame, payload.corners) : null
      currentTitleStrip = currentCard ? extractTitleStrip(frame, payload.corners) : null
      self.postMessage({ id, ok: true, result: { ok: !!currentCard } })
      return
    }

    if (type === 'loadReticle') {
      const frame = toFrame(payload.frame)
      currentCard = cropCardFromReticle(
        frame, frame.width, frame.height,
        payload.viewportWidth, payload.viewportHeight,
      )
      currentCard180 = null
      currentStrip = currentCard ? extractCollectorStripFromCard(currentCard) : null
      currentTitleStrip = currentCard ? extractTitleStripFromCard(currentCard) : null
      self.postMessage({ id, ok: true, result: { ok: !!currentCard } })
      return
    }

    if (type === 'getStrip') {
      // Hand a strip off (transfer) — OCR consumes each at most once per scan.
      let strip = null
      if (payload?.kind === 'title') {
        strip = currentTitleStrip
        currentTitleStrip = null
      } else {
        strip = currentStrip
        currentStrip = null
      }
      if (!strip) {
        self.postMessage({ id, ok: true, result: { strip: null } })
        return
      }
      self.postMessage(
        { id, ok: true, result: { strip } },
        [strip.data.buffer],
      )
      return
    }

    if (type === 'hashVariants') {
      let base = currentCard
      if (payload.rot180 && base) {
        currentCard180 ??= rotateCard180(base)
        base = currentCard180
      }
      if (!base) {
        self.postMessage({ id, ok: true, result: { results: [], fullHash: null } })
        return
      }
      const results = []
      for (const variant of payload.variants) {
        const art = cropArtRegion(base, variant)
        if (!art || !isUsableArtCrop(art)) { results.push(null); continue }
        try {
          results.push(serializeHashes(computeAllHashes(art)))
        } catch {
          results.push(null)
        }
      }
      // Whole-card hash: once per orientation, shared by all variants in the
      // batch (cached on the card object across batches).
      let fullHash = null
      try {
        base._fullHash ??= computeFullCardHash(base)
        fullHash = Array.from(base._fullHash)
      } catch { /* v1-pack behavior when absent */ }
      self.postMessage({ id, ok: true, result: { results, fullHash } })
      return
    }

    throw new Error(`Unknown vision worker message: ${type}`)
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) })
  }
}
