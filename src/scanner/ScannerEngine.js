/**
 * ScannerEngine — OpenCV.js computer vision pipeline
 *
 * OpenCV is loaded as a global <script> tag in index.html.
 * All public functions check isOpenCVReady() before using window.cv.
 * Every cv.Mat is .delete()-ed in finally blocks to prevent memory leaks.
 *
 * Pipeline:
 *   1. detectCardCorners(imageData, w, h)  → 4 ordered {x,y} points | null
 *   2. warpCard(imageData, corners)        → 500×700 ImageData (perspective-corrected)
 *   3. cropArtRegion(cardImageData)        → 450×275 ImageData (artwork strip)
 *   4. computePHash256(artImageData)       → { p1,p2,p3,p4 } BigInt (256-bit DCT hash)
 */

// ── OpenCV readiness ──────────────────────────────────────────────────────────

export function isOpenCVReady() {
  return typeof window !== 'undefined' &&
         typeof window.cv !== 'undefined' &&
         typeof window.cv.Mat !== 'undefined'
}

export function waitForOpenCV(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (isOpenCVReady()) return resolve()
    const start  = Date.now()
    const check  = setInterval(() => {
      if (isOpenCVReady()) { clearInterval(check); resolve() }
      else if (Date.now() - start > timeoutMs) {
        clearInterval(check)
        reject(new Error('OpenCV.js failed to load within timeout'))
      }
    }, 150)
  })
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

// Sort 4 points into [topLeft, topRight, bottomRight, bottomLeft]
function orderPoints(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4
  const tl = pts.filter(p => p.x <= cx && p.y <= cy).sort((a, b) => a.x - b.x)[0]
  const tr = pts.filter(p => p.x >  cx && p.y <= cy).sort((a, b) => b.x - a.x)[0]
  const br = pts.filter(p => p.x >  cx && p.y >  cy).sort((a, b) => b.x - a.x)[0]
  const bl = pts.filter(p => p.x <= cx && p.y >  cy).sort((a, b) => a.x - b.x)[0]
  // Fall back to index order if a quadrant is empty
  return [
    tl ?? pts[0], tr ?? pts[1], br ?? pts[2], bl ?? pts[3],
  ]
}

// ── 1. Card corner detection ──────────────────────────────────────────────────

/**
 * Find the best card-shaped quadrilateral in the given ImageData frame.
 * Returns an array of 4 ordered {x,y} points, or null if none found.
 */
export function detectCardCorners(imageData, width, height) {
  if (!isOpenCVReady()) return null
  const cv = window.cv

  const src      = cv.matFromImageData(imageData)
  const gray     = new cv.Mat()
  const blurred  = new cv.Mat()
  const edges    = new cv.Mat()
  const dilated  = new cv.Mat()
  const contours = new cv.MatVector()
  const hier     = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
    cv.Canny(blurred, edges, 40, 120)

    // Dilate to close small gaps in card border
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
    cv.dilate(edges, dilated, kernel)
    kernel.delete()

    cv.findContours(dilated, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    // Card must cover at least 8% of the frame
    const minArea = width * height * 0.08

    let bestPts  = null
    let bestArea = 0

    for (let i = 0; i < contours.size(); i++) {
      const cnt  = contours.get(i)
      const area = cv.contourArea(cnt)
      if (area < minArea) continue

      const peri   = cv.arcLength(cnt, true)
      const approx = new cv.Mat()
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true)

      if (approx.rows === 4) {
        const pts = []
        for (let j = 0; j < 4; j++) {
          pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] })
        }
        // MTG card aspect ratio: 63×88mm ≈ 0.716 (portrait) or 1.397 (landscape)
        const ordered = orderPoints(pts)
        const w = Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y)
        const h = Math.hypot(ordered[3].x - ordered[0].x, ordered[3].y - ordered[0].y)
        const ratio = Math.min(w, h) / Math.max(w, h)

        if (ratio >= 0.60 && ratio <= 0.80 && area > bestArea) {
          bestArea = area
          bestPts  = ordered
        }
      }
      approx.delete()
    }

    return bestPts
  } finally {
    src.delete(); gray.delete(); blurred.delete()
    edges.delete(); dilated.delete()
    contours.delete(); hier.delete()
  }
}

// ── 2. Perspective warp → 500×700 ────────────────────────────────────────────

const CARD_W = 500
const CARD_H = 700

/**
 * Warp a detected card to a standard 500×700 rectangle.
 * Returns ImageData or null on failure.
 */
export function warpCard(imageData, corners) {
  if (!isOpenCVReady() || !corners || corners.length !== 4) return null
  const cv  = window.cv
  const src = cv.matFromImageData(imageData)
  const dst = new cv.Mat()

  try {
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      corners[0].x, corners[0].y,
      corners[1].x, corners[1].y,
      corners[2].x, corners[2].y,
      corners[3].x, corners[3].y,
    ])
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,  CARD_W, 0,  CARD_W, CARD_H,  0, CARD_H,
    ])
    const M = cv.getPerspectiveTransform(srcPts, dstPts)
    cv.warpPerspective(src, dst, M, new cv.Size(CARD_W, CARD_H))
    srcPts.delete(); dstPts.delete(); M.delete()

    const canvas = document.createElement('canvas')
    canvas.width = CARD_W; canvas.height = CARD_H
    cv.imshow(canvas, dst)
    return canvas.getContext('2d').getImageData(0, 0, CARD_W, CARD_H)
  } finally {
    src.delete(); dst.delete()
  }
}

// ── 3. Crop art region ────────────────────────────────────────────────────────

// On a standard 500×700 card:
//   Name bar: y 0–55     (top strip)
//   Art box:  y 55–330   x 25–475   (450×275)
//   Text box: y 330–700  (bottom half)
const ART_X = 25, ART_Y = 55, ART_W = 450, ART_H = 275

/**
 * Crop the artwork region from a 500×700 warped card ImageData.
 * Returns 450×275 ImageData or null.
 */
export function cropArtRegion(cardImageData) {
  if (!isOpenCVReady()) return null
  const cv  = window.cv
  const src = cv.matFromImageData(cardImageData)

  try {
    const rect   = new cv.Rect(ART_X, ART_Y, ART_W, ART_H)
    const roi    = src.roi(rect)
    const canvas = document.createElement('canvas')
    canvas.width = ART_W; canvas.height = ART_H
    cv.imshow(canvas, roi)
    roi.delete()
    return canvas.getContext('2d').getImageData(0, 0, ART_W, ART_H)
  } finally {
    src.delete()
  }
}

// ── 4. 256-bit perceptual hash (DCT) ─────────────────────────────────────────

/**
 * Compute a 256-bit pHash of artwork ImageData using OpenCV's DCT.
 *
 * Algorithm:
 *   1. Grayscale + resize to 32×32
 *   2. 2D DCT  → 32×32 frequency matrix
 *   3. Take top-left 16×16 (256 low-frequency coefficients)
 *   4. Each coeff > mean(coeff[1..255]) → bit 1, else 0
 *   5. Pack 256 bits into 4 unsigned BigInt64
 *
 * Returns { p1, p2, p3, p4 } as BigInt, or null on failure.
 */
export function computePHash256(artImageData) {
  if (!isOpenCVReady()) return null
  const cv      = window.cv
  const src     = cv.matFromImageData(artImageData)
  const gray    = new cv.Mat()
  const resized = new cv.Mat()
  const floated = new cv.Mat()
  const dctMat  = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.resize(gray, resized, new cv.Size(32, 32), 0, 0, cv.INTER_AREA)
    resized.convertTo(floated, cv.CV_32F)
    cv.dct(floated, dctMat)

    // Extract top-left 16×16
    const roi    = dctMat.roi(new cv.Rect(0, 0, 16, 16))
    const values = Array.from(roi.data32F)   // 256 floats
    roi.delete()

    // Mean of indices 1..255 (skip DC component at index 0)
    const mean = values.slice(1).reduce((a, b) => a + b, 0) / 255

    // Bit array: 1 if value > mean
    const bits = values.map(v => v > mean ? 1 : 0)

    // Pack 64 bits into one unsigned BigInt
    const pack64 = (start) => {
      let r = 0n
      for (let i = 0; i < 64; i++) {
        if (bits[start + i]) r |= (1n << BigInt(i))
      }
      return r
    }

    return {
      p1: pack64(0),
      p2: pack64(64),
      p3: pack64(128),
      p4: pack64(192),
    }
  } catch { return null }
  finally {
    src.delete(); gray.delete(); resized.delete(); floated.delete(); dctMat.delete()
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Convert { p1,p2,p3,p4 } BigInt hash to 64-char hex string */
export function hashToHex({ p1, p2, p3, p4 }) {
  return [p1, p2, p3, p4]
    .map(n => n.toString(16).padStart(16, '0'))
    .join('')
}
