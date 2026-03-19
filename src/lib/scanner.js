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
 *
 * Key fixes vs v1:
 *   - getCardRect accounts for object-fit:cover cropping (portrait phone → landscape box)
 *   - preprocessNameStrip uses Otsu adaptive thresholding instead of CSS contrast filter
 */

import { createWorker } from 'tesseract.js'

// ── Tesseract worker (singleton) ──────────────────────────────────────────────

let _workerPromise = null

export async function initScanner() {
  if (_workerPromise) return _workerPromise
  _workerPromise = (async () => {
    const w = await createWorker('eng', 1, { logger: () => {} })
    await w.setParameters({
      tessedit_pageseg_mode: '7',   // single text line
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',.-'\u2019",
    })
    return w
  })()
  return _workerPromise
}

// ── Card region geometry ──────────────────────────────────────────────────────
// Accounts for object-fit:cover cropping so that the JS capture region
// matches exactly what the CSS overlay shows the user.

function getCardRect(videoEl) {
  const vW = videoEl.videoWidth  || 640
  const vH = videoEl.videoHeight || 480

  // clientWidth/clientHeight = the element's rendered size in the page.
  // When object-fit:cover is used, the video stream is cropped to fill
  // this box — so we must offset into the stream accordingly.
  const cW = videoEl.clientWidth  || vW
  const cH = videoEl.clientHeight || vH

  // In video-pixel space, which rectangle is actually visible?
  let visX = 0, visY = 0, visW = vW, visH = vH

  if (cW > 0 && cH > 0 && !(cW === vW && cH === vH)) {
    const videoAR     = vW / vH
    const containerAR = cW / cH

    if (videoAR > containerAR) {
      // Video wider than display box → cover crops left + right
      visW = Math.round(vH * containerAR)
      visX = Math.round((vW - visW) / 2)
    } else {
      // Video taller than display box → cover crops top + bottom
      visH = Math.round(vW / containerAR)
      visY = Math.round((vH - visH) / 2)
    }
  }

  // Card occupies 70% of visible height, centred, at MTG ratio 63:88
  const cardH = visH * 0.70
  const cardW = cardH * (63 / 88)
  const x = visX + (visW - cardW) / 2
  const y = visY + (visH - cardH) / 2

  return { x, y, w: cardW, h: cardH }
}

// ── Frame capture ──────────────────────────────────────────────────────────────

function captureToCanvas(videoEl) {
  const c   = document.createElement('canvas')
  c.width   = videoEl.videoWidth  || 640
  c.height  = videoEl.videoHeight || 480
  c.getContext('2d').drawImage(videoEl, 0, 0)
  return c
}

// ── Adaptive preprocessing (Otsu thresholding) ────────────────────────────────
// Much better than a CSS contrast filter for MTG card names:
//   1. Detect whether background is dark (light text) or light (dark text)
//   2. Upscale to ensure ≥60px text height for Tesseract
//   3. Compute Otsu's optimal global threshold from the histogram
//   4. Binarise + invert so text is always dark on white

function preprocessNameStrip(src, sx, sy, sw, sh) {
  // 1. Extract region at 1× into a tmp canvas so we can sample brightness
  const tmp  = document.createElement('canvas')
  tmp.width  = sw; tmp.height = sh
  const tCtx = tmp.getContext('2d', { willReadFrequently: true })
  tCtx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh)

  const raw = tCtx.getImageData(0, 0, sw, sh).data
  let meanBright = 0
  for (let i = 0; i < raw.length; i += 4)
    meanBright += (raw[i] * 299 + raw[i + 1] * 587 + raw[i + 2] * 114) / 1000
  meanBright /= (raw.length / 4)
  const darkBg = meanBright < 160   // dark background → light text → needs invert

  // 2. Scale up so strip is at least 60px tall
  const scale = Math.max(3, Math.min(8, Math.ceil(60 / Math.max(sh, 1))))
  const ow = sw * scale
  const oh = sh * scale

  const out = document.createElement('canvas')
  out.width  = ow; out.height = oh
  const ctx  = out.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(tmp, 0, 0, sw, sh, 0, 0, ow, oh)

  // 3. Otsu's method — find the threshold that minimises intra-class variance
  const imgData = ctx.getImageData(0, 0, ow, oh)
  const d       = imgData.data
  const grays   = new Uint8Array(d.length >> 2)
  const hist    = new Int32Array(256)

  for (let i = 0; i < d.length; i += 4) {
    const g = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0
    grays[i >> 2] = g
    hist[g]++
  }

  const total = grays.length
  let sumAll = 0
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]

  let sumB = 0, wB = 0, best = 0, threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue
    const wF = total - wB; if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const sigma = wB * wF * (mB - mF) ** 2
    if (sigma > best) { best = sigma; threshold = t }
  }

  // 4. Binarise; invert dark-bg images so Tesseract always sees dark text on white
  for (let i = 0; i < d.length; i += 4) {
    let v = grays[i >> 2] >= threshold ? 255 : 0
    if (darkBg) v = 255 - v
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(imgData, 0, 0)
  return out
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

  const src  = captureToCanvas(videoEl)
  const rect = getCardRect(videoEl)

  // Name strip: top ~10% of card height, left ~68% of width (avoids mana cost icons)
  const nx = Math.round(rect.x + rect.w * 0.04)
  const ny = Math.round(rect.y + rect.h * 0.03)
  const nw = Math.round(rect.w * 0.68)
  const nh = Math.round(rect.h * 0.10)

  const nameCanvas = preprocessNameStrip(src, nx, ny, nw, nh)

  try {
    const { data } = await worker.recognize(nameCanvas)
    const text = data.text.trim().replace(/[^A-Za-z ',.\-'\u2019]/g, '')
    return { text, confidence: data.confidence }
  } catch {
    return null
  }
}

// ── Perceptual hashing (dHash) ────────────────────────────────────────────────

function computeDHash(sourceCanvas, sx, sy, sw, sh) {
  const tmp  = document.createElement('canvas')
  tmp.width  = 9
  tmp.height = 8
  const tCtx = tmp.getContext('2d', { willReadFrequently: true })
  tCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, 9, 8)
  const px   = tCtx.getImageData(0, 0, 9, 8).data
  const gray = Array.from({ length: 72 }, (_, i) =>
    (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000
  )
  const bits = []
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++)
      bits.push(gray[row * 9 + col] >= gray[row * 9 + col + 1] ? 1 : 0)
  return bits
}

export function hashDistance(a, b) {
  return a.reduce((sum, bit, i) => sum + (bit !== b[i] ? 1 : 0), 0)
}

/**
 * Compute the dHash of the art region from the current video frame.
 * Art region: rows 16%–57%, cols 6%–94% of the card rect.
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
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width  = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      resolve(c)
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

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
  if (onScores) onScores(scored)

  const matches = scored.filter(s => s.score < ART_THRESHOLD)
  return (matches.length >= 1 ? matches : scored.slice(0, 3)).map(s => s.p)
}
