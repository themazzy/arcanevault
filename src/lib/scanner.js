/**
 * ArcaneVault card scanner
 *
 * Pipeline:
 *   1. Capture video frame → OCR the card name strip (Tesseract.js)
 *   2. Fuzzy-match name on Scryfall → fetch all printings
 *   3. Compute dHash of the art region on the live frame
 *   4. Compare against each printing's small thumbnail
 *   5. Return only printings whose art hash distance is below threshold
 *      (or top 3 closest if none pass)
 */

import { createWorker } from 'tesseract.js'

// ── Tesseract worker (singleton) ──────────────────────────────────────────────

let _workerPromise = null

export async function initScanner() {
  if (_workerPromise) return _workerPromise
  _workerPromise = (async () => {
    const w = await createWorker('eng', 1, { logger: () => {} })
    await w.setParameters({
      tessedit_pageseg_mode: '7',  // single text line
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',.-'",
    })
    return w
  })()
  return _workerPromise
}

// ── Card region geometry ──────────────────────────────────────────────────────
// Assumes the user holds the card upright, filling the targeting overlay.
// The overlay is centered in the frame, 70% of frame height, card aspect ratio.

function getCardRect(videoEl) {
  const vW = videoEl.videoWidth  || 640
  const vH = videoEl.videoHeight || 480
  const cardH = vH * 0.70
  const cardW = cardH * (63 / 88)
  const x = (vW - cardW) / 2
  const y = (vH - cardH) / 2
  return { x, y, w: cardW, h: cardH }
}

// ── Frame capture ──────────────────────────────────────────────────────────────

function captureToCanvas(videoEl) {
  const c = document.createElement('canvas')
  c.width  = videoEl.videoWidth  || 640
  c.height = videoEl.videoHeight || 480
  c.getContext('2d').drawImage(videoEl, 0, 0)
  return c
}

// ── OCR ───────────────────────────────────────────────────────────────────────

/**
 * OCR the card name strip from the current video frame.
 * Returns { text, confidence } or null.
 */
export async function ocrCardName(videoEl) {
  const worker = await _workerPromise
  if (!worker) return null
  if (!videoEl?.readyState || videoEl.readyState < 2) return null

  const src   = captureToCanvas(videoEl)
  const rect  = getCardRect(videoEl)

  // Name strip: top 10% of card height, left 68% of width (skip mana cost)
  const nx = Math.round(rect.x + rect.w * 0.04)
  const ny = Math.round(rect.y + rect.h * 0.03)
  const nw = Math.round(rect.w * 0.68)
  const nh = Math.round(rect.h * 0.10)

  // Upscale 3× + boost contrast for better OCR accuracy
  const scale = 3
  const nameCanvas = document.createElement('canvas')
  nameCanvas.width  = nw * scale
  nameCanvas.height = nh * scale
  const ctx = nameCanvas.getContext('2d')
  ctx.filter = 'contrast(1.5) brightness(1.1)'
  ctx.drawImage(src, nx, ny, nw, nh, 0, 0, nw * scale, nh * scale)

  try {
    const { data } = await worker.recognize(nameCanvas)
    const text = data.text.trim().replace(/[^A-Za-z ',.\-']/g, '')
    return { text, confidence: data.confidence }
  } catch {
    return null
  }
}

// ── Perceptual hashing (dHash) ────────────────────────────────────────────────
// Resizes the region to 9×8, converts to grayscale, compares adjacent pixels.
// Result: 64-bit array (0/1). Lower Hamming distance = more similar.

function computeDHash(sourceCanvas, sx, sy, sw, sh) {
  const tmp  = document.createElement('canvas')
  tmp.width  = 9
  tmp.height = 8
  const tCtx = tmp.getContext('2d', { willReadFrequently: true })
  tCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, 9, 8)
  const px = tCtx.getImageData(0, 0, 9, 8).data
  // Grayscale via luminance
  const gray = Array.from({ length: 72 }, (_, i) =>
    (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000
  )
  const bits = []
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      bits.push(gray[row * 9 + col] >= gray[row * 9 + col + 1] ? 1 : 0)
    }
  }
  return bits
}

export function hashDistance(a, b) {
  return a.reduce((sum, bit, i) => sum + (bit !== b[i] ? 1 : 0), 0)
}

/**
 * Compute the dHash of the art region from the current video frame.
 * The art occupies rows 16%–57% and columns 6%–94% of the card rect.
 */
export function getFrameArtHash(videoEl) {
  if (!videoEl?.videoWidth) return null
  const canvas = captureToCanvas(videoEl)
  const rect   = getCardRect(videoEl)
  return computeDHash(
    canvas,
    Math.round(rect.x + rect.w * 0.06),
    Math.round(rect.y + rect.h * 0.16),
    Math.round(rect.w * 0.88),
    Math.round(rect.h * 0.41),
  )
}

// ── Art matching ──────────────────────────────────────────────────────────────

function loadImageAsCanvas(url) {
  return new Promise(resolve => {
    const img       = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const c   = document.createElement('canvas')
      c.width   = img.naturalWidth
      c.height  = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      resolve(c)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * Compare a live-frame art hash against all printings.
 *
 * Returns only printings whose art hash distance is below ART_THRESHOLD.
 * If none pass the threshold, returns the top 3 closest matches.
 * Printings are sorted best-match first.
 *
 * If frameArtHash is null (no camera), returns printings as-is.
 */
const ART_THRESHOLD = 18  // out of 64 bits — ~72% similar

export async function filterPrintingsByArt(printings, frameArtHash, onScores = null) {
  if (!frameArtHash || !printings.length) return printings

  const scored = await Promise.all(printings.map(async p => {
    const url = p.image_uris?.small || p.card_faces?.[0]?.image_uris?.small
    if (!url) return { p, score: 64 }
    const canvas = await loadImageAsCanvas(url)
    if (!canvas) return { p, score: 64 }
    const score = hashDistance(
      frameArtHash,
      computeDHash(
        canvas,
        Math.round(canvas.width  * 0.06),
        Math.round(canvas.height * 0.16),
        Math.round(canvas.width  * 0.88),
        Math.round(canvas.height * 0.41),
      )
    )
    return { p, score }
  }))

  scored.sort((a, b) => a.score - b.score)
  if (onScores) onScores(scored)  // debug callback with all scores sorted

  const matches = scored.filter(s => s.score < ART_THRESHOLD)
  const result  = matches.length >= 1 ? matches : scored.slice(0, 3)
  return result.map(s => s.p)
}
