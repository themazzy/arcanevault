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

    // Adaptive Canny: scale thresholds from the image median so the detector
    // works in both dim indoor light and bright sunlight.
    const gdata  = blurred.data
    const hist   = new Int32Array(256)
    for (let i = 0; i < gdata.length; i++) hist[gdata[i]]++
    let cumul = 0, median = 127
    for (let v = 0; v < 256; v++) { cumul += hist[v]; if (cumul >= gdata.length / 2) { median = v; break } }
    const lo = Math.max(10,  Math.round(median * 0.5))
    const hi = Math.min(240, Math.round(median * 1.5))
    cv.Canny(blurred, edges, lo, hi)

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
        // MTG card is exactly 63×88mm = 0.716 aspect ratio.
        // Tight window (0.65–0.77) rejects most non-card rectangles.
        const ordered = orderPoints(pts)
        const w = Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y)
        const h = Math.hypot(ordered[3].x - ordered[0].x, ordered[3].y - ordered[0].y)
        const ratio = Math.min(w, h) / Math.max(w, h)

        if (ratio >= 0.65 && ratio <= 0.77 && area > bestArea) {
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
 * yOffset shifts the crop window up/down to compensate for slight warp residuals.
 * Returns ART_W×ART_H ImageData or null.
 */
export function cropArtRegion(cardImageData, yOffset = 0) {
  if (!isOpenCVReady()) return null
  const cv  = window.cv
  const src = cv.matFromImageData(cardImageData)
  const y   = Math.max(0, Math.min(CARD_H - ART_H, ART_Y + yOffset))

  try {
    const rect   = new cv.Rect(ART_X, y, ART_W, ART_H)
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

// Pure-JS 2D DCT — identical to the seed script (generate-card-hashes.js).
// Used as the primary path so client hashes always match DB hashes exactly.
function dct2d(matrix, N) {
  const out = new Float64Array(N * N)
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < N; u++) {
      let sum = 0
      for (let x = 0; x < N; x++) {
        sum += matrix[y * N + x] * Math.cos((2 * x + 1) * u * Math.PI / (2 * N))
      }
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1
      out[y * N + u] = (2 / N) * cu * sum / 2
    }
  }
  const tmp = out.slice()
  for (let x = 0; x < N; x++) {
    for (let v = 0; v < N; v++) {
      let sum = 0
      for (let y = 0; y < N; y++) {
        sum += tmp[y * N + x] * Math.cos((2 * y + 1) * v * Math.PI / (2 * N))
      }
      const cv2 = v === 0 ? 1 / Math.sqrt(2) : 1
      out[v * N + x] = (2 / N) * cv2 * sum / 2
    }
  }
  return out
}

/**
 * Compute a 256-bit pHash of artwork ImageData.
 *
 * Uses the same pure-JS DCT as the seed script so hashes are byte-identical.
 * OpenCV handles blur, resize, and CLAHE; DCT is pure JS to guarantee identical output.
 *
 * Returns { p1, p2, p3, p4 } as BigInt, or null on failure.
 */
export function computePHash256(artImageData) {
  if (!isOpenCVReady()) throw new Error('OpenCV not ready')
  const cv       = window.cv
  const src      = cv.matFromImageData(artImageData)
  if (!src || src.empty()) throw new Error('matFromImageData failed')
  const blurred  = new cv.Mat()
  const resized  = new cv.Mat()
  const gray     = new cv.Mat()
  const equalized = new cv.Mat()

  try {
    // 1. Gaussian blur on art crop — reduces camera sensor noise before downsampling.
    //    σ=1.0 matches sharp's .blur(1.0) used in the seed script.
    cv.GaussianBlur(src, blurred, new cv.Size(5, 5), 1.0)

    // 2. Resize blurred RGBA to 32×32 with Lanczos (matches sharp's default for downscaling)
    cv.resize(blurred, resized, new cv.Size(32, 32), 0, 0, cv.INTER_LANCZOS4)
    if (resized.empty()) throw new Error('resize to 32×32 failed')

    // 3. Convert to grayscale using BT.709 (Rec.709) to match sharp's .grayscale() default.
    //    OpenCV COLOR_RGBA2GRAY uses BT.601 which gives different values for saturated colours.
    const rgba = resized.data  // Uint8Array RGBA, 32*32*4 = 4096 bytes
    if (!rgba || rgba.length < 4096) throw new Error(`resized.data invalid (len=${rgba?.length})`)
    const grayU8 = new Uint8Array(32 * 32)
    for (let i = 0; i < 32 * 32; i++) {
      grayU8[i] = Math.round(0.2126 * rgba[i*4] + 0.7152 * rgba[i*4+1] + 0.0722 * rgba[i*4+2])
    }

    // 4. CLAHE — local contrast normalisation; handles uneven lighting better than
    //    global equalizeHist. tileGridSize=(4,4) → 8×8-pixel tiles on 32×32.
    //    clipLimit=40 → actualClip = floor(40 * 64 / 256) = 10 counts per bin.
    //    The seed script (generate-card-hashes.js) must apply the same step.
    gray.create(32, 32, cv.CV_8UC1)
    gray.data.set(grayU8)
    const clahe = cv.createCLAHE(40.0, new cv.Size(4, 4))
    clahe.apply(gray, equalized)
    clahe.delete()
    if (equalized.empty()) throw new Error('CLAHE failed')

    // 5. Read equalised pixels into Float64Array for the pure-JS DCT
    const pixels = new Float64Array(32 * 32)
    const eq8    = equalized.data
    if (!eq8 || eq8.length < 1024) throw new Error(`equalized.data invalid (len=${eq8?.length})`)
    for (let i = 0; i < pixels.length; i++) pixels[i] = eq8[i]

    const dct = dct2d(pixels, 32)

    // Extract top-left 16×16 coefficients (256 values)
    const coeffs = []
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        coeffs.push(dct[y * 32 + x])
      }
    }

    // Mean of AC components (skip DC at index 0)
    const mean = coeffs.slice(1).reduce((a, b) => a + b, 0) / 255
    const bits = coeffs.map(v => v > mean ? 1 : 0)

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
  } finally {
    src.delete(); blurred.delete(); resized.delete(); gray.delete(); equalized.delete()
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Convert { p1,p2,p3,p4 } BigInt hash to 64-char hex string */
export function hashToHex({ p1, p2, p3, p4 }) {
  return [p1, p2, p3, p4]
    .map(n => n.toString(16).padStart(16, '0'))
    .join('')
}
